use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use pdfium_render::prelude::*;
use piff_core::{
    compare_images_with_cancellation, fingerprint_image, pair_page_fingerprints, Alignment,
    DiffError, DiffOptions, DiffRegion, PagePair,
};
use piff_semantic::{
    compare_runs_with_extraction_and_options, normalize_text_runs_with_reading_order,
    SemanticBounds, SemanticChangeKind, SemanticPageDiff, SemanticTextBlockKind,
    SemanticTextBlockRole, TextDiff, TextDiffOptions, TextExtractionQuality, TextExtractionSummary,
    TextFragment, TextReadingOrder, TextRun, MAX_TEXT_DIFF_CONTEXT_LINES,
};
use serde::Serialize;
use thiserror::Error;

const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);
const PAGE_FINGERPRINT_DPI: f32 = 24.0;
const PAGE_FINGERPRINT_SIZE: u32 = 32;
const MAX_RENDER_TILE_HEIGHT: i32 = 1024;
const ALIGNMENT_WARNING_THRESHOLD: f32 = 0.75;
const ROLE_EDGE_BAND_RATIO: f32 = 0.15;
const ROLE_MIN_EDGE_BAND: f32 = 24.0;
const ROLE_MAX_TEXT_LENGTH: usize = 240;

static PDFIUM: OnceLock<Result<Mutex<Pdfium>, String>> = OnceLock::new();

pub const DEFAULT_MAX_INPUT_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_PAGES: usize = 1_000;
pub const DEFAULT_MAX_PAGE_PIXELS: u64 = 25_000_000;
pub const RESULT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct PdfEngineInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub renderer: &'static str,
    pub binding: &'static str,
}

pub const ENGINE_INFO: PdfEngineInfo = PdfEngineInfo {
    name: "piff",
    version: env!("CARGO_PKG_VERSION"),
    renderer: "pdfium",
    binding: "pdfium-render",
};

#[derive(Debug, Clone, Copy)]
pub struct PdfResourceLimits {
    pub max_input_bytes: Option<usize>,
    pub max_pages: Option<usize>,
    pub max_page_pixels: Option<u64>,
}

impl PdfResourceLimits {
    pub const fn unlimited() -> Self {
        Self {
            max_input_bytes: None,
            max_pages: None,
            max_page_pixels: None,
        }
    }
}

impl Default for PdfResourceLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES),
            max_pages: Some(DEFAULT_MAX_PAGES),
            max_page_pixels: Some(DEFAULT_MAX_PAGE_PIXELS),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PiffOptions {
    pub dpi: f32,
    pub diff: DiffOptions,
    pub page_matching: PageMatching,
    pub mode: PiffMode,
    pub reading_order: TextReadingOrder,
    pub text_context_lines: usize,
    pub include_previews: bool,
    pub limits: PdfResourceLimits,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PageMatching {
    #[default]
    Index,
    Sequence,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PiffMode {
    #[default]
    Visual,
    Semantic,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PreviewView {
    Before,
    After,
    #[default]
    Diff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressPhase {
    Loading,
    Fingerprinting,
    Rendering,
    Comparing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressEvent {
    pub phase: ProgressPhase,
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PdfRenderOptions<'a> {
    pub password: Option<&'a str>,
    pub cancellation: Option<&'a CancellationToken>,
}

/// Passwords used to open the before and after documents.
///
/// The shared-password helpers remain the convenient path for the common case. Use this type
/// when the two PDFs come from sources with different credentials.
#[derive(Debug, Clone, Copy, Default)]
pub struct PdfPasswords<'a> {
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
}

impl<'a> PdfPasswords<'a> {
    pub const fn shared(password: Option<&'a str>) -> Self {
        Self {
            before: password,
            after: password,
        }
    }
}

/// Passwords and cancellation state for a page preview request.
#[derive(Debug, Clone, Copy, Default)]
pub struct PdfRenderRequest<'a> {
    pub passwords: PdfPasswords<'a>,
    pub cancellation: Option<&'a CancellationToken>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Default for PiffOptions {
    fn default() -> Self {
        Self {
            dpi: 144.0,
            diff: DiffOptions::default(),
            page_matching: PageMatching::default(),
            mode: PiffMode::default(),
            reading_order: TextReadingOrder::default(),
            text_context_lines: piff_semantic::DEFAULT_TEXT_DIFF_CONTEXT_LINES,
            include_previews: false,
            limits: PdfResourceLimits::default(),
        }
    }
}

#[derive(Debug, Error)]
pub enum PiffError {
    #[error("comparison was cancelled")]
    Cancelled,
    #[error("dpi must be greater than zero")]
    InvalidDpi,
    #[error("max_input_bytes must be greater than zero")]
    InvalidMaxInputBytes,
    #[error("max_pages must be greater than zero")]
    InvalidMaxPages,
    #[error("max_page_pixels must be greater than zero")]
    InvalidMaxPagePixels,
    #[error("text_context_lines must be at most {MAX_TEXT_DIFF_CONTEXT_LINES}")]
    InvalidTextContextLines,
    #[error("{document} PDF is {bytes} bytes, exceeding the {max_bytes}-byte input limit")]
    InputTooLarge {
        document: &'static str,
        bytes: usize,
        max_bytes: usize,
    },
    #[error("could not inspect {document} PDF input: {message}")]
    InputMetadata {
        document: &'static str,
        message: String,
    },
    #[error("{document} PDF requires a password or the supplied password is incorrect")]
    PasswordRequired { document: &'static str },
    #[error("{document} PDF uses unsupported security settings")]
    SecurityUnsupported { document: &'static str },
    #[error("{document} PDF has {page_count} pages, exceeding the {max_pages}-page limit")]
    PageLimitExceeded {
        document: &'static str,
        page_count: usize,
        max_pages: usize,
    },
    #[error(
        "rendered page is {width}x{height} pixels ({pixels} pixels), exceeding the {max_pixels}-pixel limit"
    )]
    PagePixelsExceeded {
        width: u32,
        height: u32,
        pixels: u64,
        max_pixels: u64,
    },
    #[error("rendered page dimensions are too large for PDFium")]
    PageDimensionsTooLarge,
    #[error("could not bind to Pdfium: {0}")]
    PdfiumBinding(String),
    #[error("Pdfium error: {0}")]
    Pdfium(String),
    #[error("could not convert rendered page to an RGBA image")]
    ImageConversion,
    #[error("page index {page_index} is out of bounds for a {page_count}-page comparison")]
    PageIndexOutOfBounds {
        page_index: usize,
        page_count: usize,
    },
    #[error("could not encode page diff preview: {0}")]
    PreviewEncoding(String),
    #[error("preview view must be \"before\", \"after\", or \"diff\"")]
    InvalidPreviewView,
    #[error("could not extract positioned text: {0}")]
    TextExtraction(String),
    #[error(transparent)]
    Diff(#[from] DiffError),
}

impl PiffError {
    /// Stable machine-readable classification for SDKs and command-line callers.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::InvalidDpi
            | Self::InvalidMaxInputBytes
            | Self::InvalidMaxPages
            | Self::InvalidMaxPagePixels
            | Self::InvalidTextContextLines => "invalid-options",
            Self::InputTooLarge { .. } => "input-too-large",
            Self::InputMetadata { .. } => "input-metadata",
            Self::PasswordRequired { .. } => "password-required",
            Self::SecurityUnsupported { .. } => "pdf-security",
            Self::PageLimitExceeded { .. } => "page-limit-exceeded",
            Self::PagePixelsExceeded { .. } => "page-pixels-exceeded",
            Self::PageDimensionsTooLarge => "page-dimensions-too-large",
            Self::PdfiumBinding(_) => "pdfium-binding",
            Self::Pdfium(_) => "pdfium",
            Self::ImageConversion => "image-conversion",
            Self::PageIndexOutOfBounds { .. } => "page-index-out-of-bounds",
            Self::PreviewEncoding(_) => "preview-encoding",
            Self::InvalidPreviewView => "invalid-preview-view",
            Self::TextExtraction(_) => "text-extraction",
            Self::Diff(_) => "comparison",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PageStatus {
    Equal,
    Modified,
    Inserted,
    Deleted,
    Moved,
}

/// The unscaled PDF page box used by positioned text bounds.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct PageGeometry {
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Default)]
struct DocumentRoleEvidence {
    before: HashMap<(SemanticTextBlockRole, String), HashSet<usize>>,
    after: HashMap<(SemanticTextBlockRole, String), HashSet<usize>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FigureStatus {
    Added,
    Removed,
    Modified,
    Moved,
    Swapped,
}

/// A changed image-backed figure discovered from the PDF page object stream.
///
/// The raster diff remains authoritative for the page verdict. These records add identity and
/// side-specific geometry where Pdfium exposes a stable image object, which lets consumers show a
/// moved or swapped figure as one review item instead of a collection of pixel regions.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PdfFigureDiff {
    pub id: String,
    pub status: FigureStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_bounds: Option<SemanticBounds>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageWarning {
    LowAlignmentConfidence,
    ContentReordered,
    TextUnavailable,
    TextPartial,
    TextSuspect,
    TextDiffTruncated,
    TextChangesTruncated,
    PageGeometryChanged,
    SemanticVisualDisagreement,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PiffStats {
    pub load_ms: f64,
    pub fingerprint_ms: f64,
    pub matching_ms: f64,
    pub render_ms: f64,
    pub compare_ms: f64,
    pub region_ms: f64,
    pub semantic_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct PdfPageDiff {
    pub before_page: Option<usize>,
    pub after_page: Option<usize>,
    pub status: PageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_size: Option<PageGeometry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_size: Option<PageGeometry>,
    pub width: u32,
    pub height: u32,
    pub changed_pixels: u64,
    pub changed_ratio: f32,
    pub alignment: Alignment,
    pub regions: Vec<DiffRegion>,
    pub figures: Vec<PdfFigureDiff>,
    pub warnings: Vec<PageWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic: Option<SemanticPageDiff>,
    #[serde(skip)]
    pub preview: RgbaImage,
}

#[derive(Debug, Serialize)]
pub struct PiffResult {
    pub schema_version: u32,
    pub engine: PdfEngineInfo,
    pub equal: bool,
    pub before_page_count: usize,
    pub after_page_count: usize,
    pub pages: Vec<PdfPageDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_diff: Option<PdfDocumentTextDiff>,
    pub stats: PiffStats,
}

#[derive(Debug, Serialize)]
pub struct PdfDocumentTextDiff {
    pub changed_lines: usize,
    pub truncated: bool,
    pub pages: Vec<PdfDocumentTextDiffPage>,
    pub stream: Vec<PdfDocumentReviewItem>,
}

#[derive(Debug, Serialize)]
pub struct PdfDocumentTextDiffPage {
    pub before_page: Option<usize>,
    pub after_page: Option<usize>,
    pub status: PageStatus,
    pub blocks: Vec<piff_semantic::SemanticTextBlockDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_diff: Option<TextDiff>,
}

/// One canonical text operation in document order.
///
/// `page_index` is the zero-based position in the paired result sequence. The
/// independent `before_page` and `after_page` anchors make inserted, deleted,
/// and moved pages explicit to inline consumers.
#[derive(Debug, Serialize)]
pub struct PdfDocumentReviewItem {
    pub id: String,
    pub page_index: usize,
    pub before_page: Option<usize>,
    pub after_page: Option<usize>,
    pub page_status: PageStatus,
    pub block_id: String,
    pub kind: SemanticChangeKind,
    pub structure: SemanticTextBlockKind,
    pub confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_focus_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_focus_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_role: Option<SemanticTextBlockRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_role: Option<SemanticTextBlockRole>,
    pub text_diff: TextDiff,
}

/// Verifies that the configured Pdfium backend can be loaded.
#[cfg(not(target_arch = "wasm32"))]
pub fn check_pdfium(library_path: Option<&Path>) -> Result<PdfEngineInfo, PiffError> {
    with_pdfium(library_path, |_| Ok(ENGINE_INFO))
}

/// Compares two PDFs using one shared Pdfium instance.
#[cfg(not(target_arch = "wasm32"))]
pub fn compare_files(
    before_path: impl AsRef<Path>,
    after_path: impl AsRef<Path>,
    library_path: Option<&Path>,
    options: PiffOptions,
) -> Result<PiffResult, PiffError> {
    compare_files_with_password(before_path, after_path, library_path, options, None)
}

/// Compares two PDF files with an optional shared password for encrypted documents.
#[cfg(not(target_arch = "wasm32"))]
pub fn compare_files_with_password(
    before_path: impl AsRef<Path>,
    after_path: impl AsRef<Path>,
    library_path: Option<&Path>,
    options: PiffOptions,
    password: Option<&str>,
) -> Result<PiffResult, PiffError> {
    compare_files_with_passwords(
        before_path,
        after_path,
        library_path,
        options,
        PdfPasswords::shared(password),
    )
}

/// Compares two PDF files with independent optional passwords for each document.
#[cfg(not(target_arch = "wasm32"))]
pub fn compare_files_with_passwords(
    before_path: impl AsRef<Path>,
    after_path: impl AsRef<Path>,
    library_path: Option<&Path>,
    options: PiffOptions,
    passwords: PdfPasswords<'_>,
) -> Result<PiffResult, PiffError> {
    validate_options(options)?;
    ensure_file_input_limit(
        before_path.as_ref(),
        "before",
        options.limits.max_input_bytes,
    )?;
    ensure_file_input_limit(after_path.as_ref(), "after", options.limits.max_input_bytes)?;
    let started = Instant::now();
    with_pdfium(library_path, |pdfium| {
        let load_started = Instant::now();
        let (before, after) =
            load_pdf_pair_from_files(pdfium, before_path.as_ref(), after_path.as_ref(), passwords)?;
        let load_ms = elapsed_ms(load_started);
        let retry_encrypted = needs_encrypted_semantic_retry(options, &before, &after);
        let first = compare_documents(&before, &after, options, started, load_ms, None, None)?;
        if !retry_encrypted {
            return Ok(first);
        }

        // PDFium lazily initializes text extraction for protected documents. Discard the
        // initialization pass so callers receive the steady-state result on their first call.
        let first_stats = first.stats;
        drop(first);
        drop(before);
        drop(after);
        let retry_started = Instant::now();
        let (before, after) =
            load_pdf_pair_from_files(pdfium, before_path.as_ref(), after_path.as_ref(), passwords)?;
        let retry_load_ms = elapsed_ms(retry_started);
        let mut result =
            compare_documents(&before, &after, options, started, retry_load_ms, None, None)?;
        add_retry_stats(&mut result, first_stats);
        Ok(result)
    })
}

/// Compares PDF bytes without requiring callers to write temporary files.
pub fn compare_bytes(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
) -> Result<PiffResult, PiffError> {
    compare_bytes_with_progress(before_bytes, after_bytes, library_path, options, None, None)
}

/// Compares PDF bytes and reports bounded progress events after each pipeline stage.
pub fn compare_bytes_with_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<PiffResult, PiffError> {
    compare_bytes_with_password_and_progress(
        before_bytes,
        after_bytes,
        library_path,
        options,
        None,
        progress,
        cancellation,
    )
}

/// Compares PDF bytes with an optional shared password and bounded progress reporting.
pub fn compare_bytes_with_password_and_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    password: Option<&str>,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<PiffResult, PiffError> {
    compare_bytes_with_passwords_and_progress(
        before_bytes,
        after_bytes,
        library_path,
        options,
        PdfPasswords::shared(password),
        progress,
        cancellation,
    )
}

/// Compares PDF bytes with independent optional passwords for each document.
pub fn compare_bytes_with_passwords_and_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    passwords: PdfPasswords<'_>,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<PiffResult, PiffError> {
    validate_options(options)?;
    ensure_byte_input_limits(&before_bytes, &after_bytes, options.limits.max_input_bytes)?;
    ensure_not_cancelled(cancellation)?;
    let identical_inputs = before_bytes == after_bytes;
    let options = if identical_inputs {
        PiffOptions {
            page_matching: PageMatching::Index,
            ..options
        }
    } else {
        options
    };
    let started = Instant::now();
    with_pdfium(library_path, |pdfium| {
        let load_started = Instant::now();
        let (before, after) =
            load_pdf_pair_from_byte_slices(pdfium, &before_bytes, &after_bytes, passwords)?;
        let load_ms = elapsed_ms(load_started);
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Loading,
                completed: 1,
                total: 1,
            },
        );
        let retry_encrypted = needs_encrypted_semantic_retry(options, &before, &after);
        let first = compare_documents(
            &before,
            &after,
            options,
            started,
            load_ms,
            progress,
            cancellation,
        )?;
        if !retry_encrypted {
            return Ok(first);
        }

        let first_stats = first.stats;
        drop(first);
        ensure_not_cancelled(cancellation)?;
        drop(before);
        drop(after);
        let retry_started = Instant::now();
        let (before, after) =
            load_pdf_pair_from_byte_slices(pdfium, &before_bytes, &after_bytes, passwords)?;
        let retry_load_ms = elapsed_ms(retry_started);
        let mut result = compare_documents(
            &before,
            &after,
            options,
            started,
            retry_load_ms,
            progress,
            cancellation,
        )?;
        add_retry_stats(&mut result, first_stats);
        Ok(result)
    })
}

/// Checks equality while stopping after the first changed page.
pub fn is_equal_bytes(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
) -> Result<bool, PiffError> {
    is_equal_bytes_with_progress(before_bytes, after_bytes, library_path, options, None, None)
}

/// Checks equality and reports progress until the first changed page.
pub fn is_equal_bytes_with_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<bool, PiffError> {
    is_equal_bytes_with_password_and_progress(
        before_bytes,
        after_bytes,
        library_path,
        options,
        None,
        progress,
        cancellation,
    )
}

/// Checks equality with an optional shared password and bounded progress reporting.
pub fn is_equal_bytes_with_password_and_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    password: Option<&str>,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<bool, PiffError> {
    is_equal_bytes_with_passwords_and_progress(
        before_bytes,
        after_bytes,
        library_path,
        options,
        PdfPasswords::shared(password),
        progress,
        cancellation,
    )
}

/// Checks equality with independent optional passwords for each document.
pub fn is_equal_bytes_with_passwords_and_progress(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    library_path: Option<&Path>,
    options: PiffOptions,
    passwords: PdfPasswords<'_>,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<bool, PiffError> {
    validate_options(options)?;
    ensure_byte_input_limits(&before_bytes, &after_bytes, options.limits.max_input_bytes)?;
    ensure_not_cancelled(cancellation)?;
    let identical_inputs = before_bytes == after_bytes;
    let options = if identical_inputs {
        PiffOptions {
            page_matching: PageMatching::Index,
            ..options
        }
    } else {
        options
    };
    with_pdfium(library_path, |pdfium| {
        let (before, after) =
            load_pdf_pair_from_byte_slices(pdfium, &before_bytes, &after_bytes, passwords)?;
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Loading,
                completed: 1,
                total: 1,
            },
        );
        let retry_encrypted = needs_encrypted_semantic_retry(options, &before, &after);
        let first = is_equal_loaded_documents(&before, &after, options, progress, cancellation)?;
        if !retry_encrypted {
            return Ok(first);
        }

        ensure_not_cancelled(cancellation)?;
        drop(before);
        drop(after);
        let (before, after) =
            load_pdf_pair_from_byte_slices(pdfium, &before_bytes, &after_bytes, passwords)?;
        is_equal_loaded_documents(&before, &after, options, progress, cancellation)
    })
}

fn is_equal_loaded_documents(
    before: &PdfDocument<'_>,
    after: &PdfDocument<'_>,
    options: PiffOptions,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<bool, PiffError> {
    let (page_pairs, _, _) = build_page_pairs(before, after, options, progress, cancellation)?;
    let mut role_evidence = DocumentRoleEvidence::default();

    for (page_index, page_pair) in page_pairs.iter().copied().enumerate() {
        ensure_not_cancelled(cancellation)?;
        let (Some(before_page), Some(after_page)) = (page_pair.before, page_pair.after) else {
            return Ok(false);
        };
        if page_pair.moved {
            return Ok(false);
        }
        let before_page = before
            .pages()
            .get(before_page as i32)
            .map_err(pdfium_error)?;
        let after_page = after.pages().get(after_page as i32).map_err(pdfium_error)?;
        if page_geometry(&before_page) != page_geometry(&after_page) {
            return Ok(false);
        }
        let before_image = render_page(
            &before_page,
            options.dpi,
            cancellation,
            options.limits.max_page_pixels,
        )?;
        let after_image = render_page(
            &after_page,
            options.dpi,
            cancellation,
            options.limits.max_page_pixels,
        )?;
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Rendering,
                completed: page_index + 1,
                total: page_pairs.len(),
            },
        );
        if !compare_images_with_cancellation(&before_image, &after_image, options.diff, || {
            cancellation.is_some_and(CancellationToken::is_cancelled)
        })?
        .equal
        {
            return Ok(false);
        }
        if matches!(options.mode, PiffMode::Semantic)
            && !compare_semantic_pages(
                before,
                after,
                page_pair,
                options.reading_order,
                options.text_context_lines,
                cancellation,
                &mut role_evidence,
            )?
            .equal
        {
            return Ok(false);
        }
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Comparing,
                completed: page_index + 1,
                total: page_pairs.len(),
            },
        );
    }

    Ok(true)
}

/// Renders one lazily requested page diff as a PNG.
///
/// This intentionally loads and renders only the requested page pair. Callers that need
/// metadata for every page should use `compare_bytes` or `compare_files` first.
pub fn render_page_diff_png(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    page_index: usize,
    library_path: Option<&Path>,
    options: PiffOptions,
    view: PreviewView,
) -> Result<Vec<u8>, PiffError> {
    render_page_diff_png_with_cancellation(
        before_bytes,
        after_bytes,
        page_index,
        library_path,
        options,
        view,
        None,
    )
}

/// Renders one page diff while allowing a caller to cancel between render and compare stages.
pub fn render_page_diff_png_with_cancellation(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    page_index: usize,
    library_path: Option<&Path>,
    options: PiffOptions,
    view: PreviewView,
    cancellation: Option<&CancellationToken>,
) -> Result<Vec<u8>, PiffError> {
    render_page_diff_png_with_password_and_cancellation(
        before_bytes,
        after_bytes,
        page_index,
        library_path,
        options,
        view,
        PdfRenderOptions {
            password: None,
            cancellation,
        },
    )
}

/// Renders one page diff with an optional shared password for encrypted documents.
pub fn render_page_diff_png_with_password_and_cancellation(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    page_index: usize,
    library_path: Option<&Path>,
    options: PiffOptions,
    view: PreviewView,
    render_options: PdfRenderOptions<'_>,
) -> Result<Vec<u8>, PiffError> {
    render_page_diff_png_with_passwords_and_cancellation(
        before_bytes,
        after_bytes,
        page_index,
        library_path,
        options,
        view,
        PdfRenderRequest {
            passwords: PdfPasswords::shared(render_options.password),
            cancellation: render_options.cancellation,
        },
    )
}

/// Renders one page diff with independent optional passwords for each document.
pub fn render_page_diff_png_with_passwords_and_cancellation(
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    page_index: usize,
    library_path: Option<&Path>,
    options: PiffOptions,
    view: PreviewView,
    request: PdfRenderRequest<'_>,
) -> Result<Vec<u8>, PiffError> {
    validate_options(options)?;
    ensure_byte_input_limits(&before_bytes, &after_bytes, options.limits.max_input_bytes)?;
    ensure_not_cancelled(request.cancellation)?;
    with_pdfium(library_path, |pdfium| {
        let before = load_pdf_from_bytes(pdfium, before_bytes, request.passwords.before, "before")?;
        let after = load_pdf_from_bytes(pdfium, after_bytes, request.passwords.after, "after")?;
        let (page_pairs, _, _) =
            build_page_pairs(&before, &after, options, None, request.cancellation)?;
        if page_index >= page_pairs.len() {
            return Err(PiffError::PageIndexOutOfBounds {
                page_index,
                page_count: page_pairs.len(),
            });
        }
        let page_pair = page_pairs[page_index];

        let before_image = if let Some(before_page) = page_pair.before {
            Some(render_page(
                &before
                    .pages()
                    .get(before_page as i32)
                    .map_err(pdfium_error)?,
                options.dpi,
                request.cancellation,
                options.limits.max_page_pixels,
            )?)
        } else {
            None
        };
        let after_image = if let Some(after_page) = page_pair.after {
            Some(render_page(
                &after.pages().get(after_page as i32).map_err(pdfium_error)?,
                options.dpi,
                request.cancellation,
                options.limits.max_page_pixels,
            )?)
        } else {
            None
        };

        let status = if page_pair.moved {
            PageStatus::Moved
        } else {
            match (before_image.is_some(), after_image.is_some()) {
                (true, true) => PageStatus::Modified,
                (true, false) => PageStatus::Deleted,
                (false, true) => PageStatus::Inserted,
                (false, false) => unreachable!("page index was checked against both page counts"),
            }
        };
        let before_image = before_image.unwrap_or_else(|| {
            let image = after_image.as_ref().expect("an after page exists");
            RgbaImage::from_pixel(image.width(), image.height(), WHITE)
        });
        let after_image = after_image.unwrap_or_else(|| {
            RgbaImage::from_pixel(before_image.width(), before_image.height(), WHITE)
        });
        let diff_options = if matches!(status, PageStatus::Modified | PageStatus::Moved) {
            options.diff
        } else {
            DiffOptions {
                max_shift_px: 0,
                ..options.diff
            }
        };
        let page_diff =
            compare_images_with_cancellation(&before_image, &after_image, diff_options, || {
                request
                    .cancellation
                    .is_some_and(CancellationToken::is_cancelled)
            })?;
        let preview = match view {
            PreviewView::Before => {
                project_image(&before_image, page_diff.width, page_diff.height, 0, 0)
            }
            PreviewView::After => project_image(
                &after_image,
                page_diff.width,
                page_diff.height,
                page_diff.alignment.offset_x,
                page_diff.alignment.offset_y,
            ),
            PreviewView::Diff => page_diff.preview,
        };
        encode_png(preview)
    })
}

fn validate_options(options: PiffOptions) -> Result<(), PiffError> {
    if options.dpi <= 0.0 || !options.dpi.is_finite() {
        return Err(PiffError::InvalidDpi);
    }
    if options.limits.max_input_bytes == Some(0) {
        return Err(PiffError::InvalidMaxInputBytes);
    }
    if options.limits.max_pages == Some(0) {
        return Err(PiffError::InvalidMaxPages);
    }
    if options.limits.max_page_pixels == Some(0) {
        return Err(PiffError::InvalidMaxPagePixels);
    }
    if options.text_context_lines > MAX_TEXT_DIFF_CONTEXT_LINES {
        return Err(PiffError::InvalidTextContextLines);
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn ensure_file_input_limit(
    path: &Path,
    document: &'static str,
    max_input_bytes: Option<usize>,
) -> Result<(), PiffError> {
    let Some(max_input_bytes) = max_input_bytes else {
        return Ok(());
    };
    let bytes = std::fs::metadata(path)
        .map_err(|error| PiffError::InputMetadata {
            document,
            message: error.to_string(),
        })?
        .len();
    if bytes > max_input_bytes as u64 {
        return Err(PiffError::InputTooLarge {
            document,
            bytes: bytes.min(usize::MAX as u64) as usize,
            max_bytes: max_input_bytes,
        });
    }
    Ok(())
}

fn ensure_byte_input_limits(
    before: &[u8],
    after: &[u8],
    max_input_bytes: Option<usize>,
) -> Result<(), PiffError> {
    let Some(max_input_bytes) = max_input_bytes else {
        return Ok(());
    };
    for (document, bytes) in [("before", before.len()), ("after", after.len())] {
        if bytes > max_input_bytes {
            return Err(PiffError::InputTooLarge {
                document,
                bytes,
                max_bytes: max_input_bytes,
            });
        }
    }
    Ok(())
}

fn ensure_page_limit(
    document: &'static str,
    page_count: usize,
    max_pages: Option<usize>,
) -> Result<(), PiffError> {
    if let Some(max_pages) = max_pages {
        if page_count > max_pages {
            return Err(PiffError::PageLimitExceeded {
                document,
                page_count,
                max_pages,
            });
        }
    }
    Ok(())
}

fn ensure_page_pixels(
    width: u32,
    height: u32,
    max_page_pixels: Option<u64>,
) -> Result<(), PiffError> {
    let pixels = u64::from(width) * u64::from(height);
    if let Some(max_pixels) = max_page_pixels {
        if pixels > max_pixels {
            return Err(PiffError::PagePixelsExceeded {
                width,
                height,
                pixels,
                max_pixels,
            });
        }
    }
    Ok(())
}

const FIGURE_POSITION_TOLERANCE: f32 = 1.5;
const FIGURE_FALLBACK_DISTANCE: f32 = 64.0;

#[derive(Debug, Clone, Copy)]
struct ImageFigure {
    bounds: SemanticBounds,
    fingerprint: u64,
}

#[derive(Debug, Clone, Copy)]
struct FigureMatch {
    before_index: usize,
    after_index: usize,
    exact_identity: bool,
    confidence: f32,
}

fn compare_image_figures(
    before_document: &PdfDocument<'_>,
    before_page: &PdfPage<'_>,
    after_document: &PdfDocument<'_>,
    after_page: &PdfPage<'_>,
) -> Vec<PdfFigureDiff> {
    let before = extract_image_figures(before_document, before_page);
    let after = extract_image_figures(after_document, after_page);
    if before.is_empty() && after.is_empty() {
        return Vec::new();
    }

    let mut before_used = vec![false; before.len()];
    let mut after_used = vec![false; after.len()];
    let mut matches = Vec::new();

    for (before_index, before_figure) in before.iter().enumerate() {
        let candidate = after
            .iter()
            .enumerate()
            .filter(|(after_index, after_figure)| {
                !after_used[*after_index] && after_figure.fingerprint == before_figure.fingerprint
            })
            .min_by(|(_, left), (_, right)| {
                figure_center_distance(before_figure.bounds, left.bounds)
                    .total_cmp(&figure_center_distance(before_figure.bounds, right.bounds))
            });

        if let Some((after_index, _)) = candidate {
            before_used[before_index] = true;
            after_used[after_index] = true;
            matches.push(FigureMatch {
                before_index,
                after_index,
                exact_identity: true,
                confidence: 1.0,
            });
        }
    }

    for (before_index, before_figure) in before.iter().enumerate() {
        if before_used[before_index] {
            continue;
        }
        let candidate = after
            .iter()
            .enumerate()
            .filter_map(|(after_index, after_figure)| {
                if after_used[after_index] {
                    return None;
                }
                figure_slot_score(before_figure.bounds, after_figure.bounds)
                    .map(|score| (after_index, score))
            })
            .max_by(|(_, left), (_, right)| left.total_cmp(right));

        if let Some((after_index, confidence)) = candidate {
            before_used[before_index] = true;
            after_used[after_index] = true;
            matches.push(FigureMatch {
                before_index,
                after_index,
                exact_identity: false,
                confidence,
            });
        }
    }

    let swapped = matches
        .iter()
        .map(|figure_match| {
            if !figure_match.exact_identity
                || bounds_close(
                    before[figure_match.before_index].bounds,
                    after[figure_match.after_index].bounds,
                )
            {
                return false;
            }
            matches.iter().any(|other| {
                other.exact_identity
                    && other.before_index != figure_match.before_index
                    && bounds_overlap_ratio(
                        after[figure_match.after_index].bounds,
                        before[other.before_index].bounds,
                    ) >= 0.6
                    && bounds_overlap_ratio(
                        after[other.after_index].bounds,
                        before[figure_match.before_index].bounds,
                    ) >= 0.6
            })
        })
        .collect::<Vec<_>>();

    let mut result = Vec::new();
    for (match_index, figure_match) in matches.iter().enumerate() {
        let before_figure = before[figure_match.before_index];
        let after_figure = after[figure_match.after_index];
        let status = if figure_match.exact_identity {
            if bounds_close(before_figure.bounds, after_figure.bounds) {
                None
            } else if swapped[match_index] {
                Some(FigureStatus::Swapped)
            } else {
                Some(FigureStatus::Moved)
            }
        } else {
            Some(FigureStatus::Modified)
        };
        if let Some(status) = status {
            result.push(PdfFigureDiff {
                id: format!("figure-{}", result.len() + 1),
                status,
                before_bounds: Some(before_figure.bounds),
                after_bounds: Some(after_figure.bounds),
                confidence: figure_match.confidence,
            });
        }
    }

    for (before_index, before_figure) in before.iter().enumerate() {
        if !before_used[before_index] {
            result.push(PdfFigureDiff {
                id: format!("figure-{}", result.len() + 1),
                status: FigureStatus::Removed,
                before_bounds: Some(before_figure.bounds),
                after_bounds: None,
                confidence: 1.0,
            });
        }
    }
    for (after_index, after_figure) in after.iter().enumerate() {
        if !after_used[after_index] {
            result.push(PdfFigureDiff {
                id: format!("figure-{}", result.len() + 1),
                status: FigureStatus::Added,
                before_bounds: None,
                after_bounds: Some(after_figure.bounds),
                confidence: 1.0,
            });
        }
    }

    result
}

fn extract_image_figures(document: &PdfDocument<'_>, page: &PdfPage<'_>) -> Vec<ImageFigure> {
    let page_height = page.height().value;
    page.objects()
        .iter()
        .filter_map(|object| {
            let image = object.as_image_object()?;
            let bounds = object.bounds().ok()?;
            let width = bounds.width().value;
            let height = bounds.height().value;
            if !width.is_finite() || !height.is_finite() || width <= 1.0 || height <= 1.0 {
                return None;
            }
            let fingerprint = image
                .get_processed_bitmap_with_size(document, 32, 32)
                .map(|bitmap| hash_image_data(&bitmap.as_rgba_bytes()))
                .or_else(|_| {
                    image
                        .get_raw_image_data()
                        .map(|raw_data| hash_image_data(&raw_data))
                })
                .ok()?;
            Some(ImageFigure {
                bounds: SemanticBounds::new(
                    bounds.left().value,
                    page_height - bounds.top().value,
                    width,
                    height,
                ),
                fingerprint,
            })
        })
        .collect()
}

fn hash_image_data(data: &[u8]) -> u64 {
    let mut hash = 14_695_981_039_346_656_037_u64;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn bounds_close(left: SemanticBounds, right: SemanticBounds) -> bool {
    (left.x - right.x).abs() <= FIGURE_POSITION_TOLERANCE
        && (left.y - right.y).abs() <= FIGURE_POSITION_TOLERANCE
        && (left.width - right.width).abs() <= FIGURE_POSITION_TOLERANCE
        && (left.height - right.height).abs() <= FIGURE_POSITION_TOLERANCE
}

fn figure_center_distance(left: SemanticBounds, right: SemanticBounds) -> f32 {
    let left_center_x = left.x + left.width / 2.0;
    let left_center_y = left.y + left.height / 2.0;
    let right_center_x = right.x + right.width / 2.0;
    let right_center_y = right.y + right.height / 2.0;
    ((left_center_x - right_center_x).powi(2) + (left_center_y - right_center_y).powi(2)).sqrt()
}

fn bounds_overlap_ratio(left: SemanticBounds, right: SemanticBounds) -> f32 {
    let intersection = intersection_area(left, right);
    let smaller_area = bounds_area(left).min(bounds_area(right));
    if smaller_area <= 0.0 {
        0.0
    } else {
        intersection / smaller_area
    }
}

fn figure_slot_score(left: SemanticBounds, right: SemanticBounds) -> Option<f32> {
    let overlap = bounds_overlap_ratio(left, right);
    let distance = figure_center_distance(left, right);
    let size_similarity = {
        let left_area = bounds_area(left);
        let right_area = bounds_area(right);
        if left_area <= 0.0 || right_area <= 0.0 {
            return None;
        }
        left_area.min(right_area) / left_area.max(right_area)
    };
    if overlap < 0.2 && distance > FIGURE_FALLBACK_DISTANCE {
        return None;
    }
    let distance_score = (1.0 - distance / FIGURE_FALLBACK_DISTANCE).max(0.0);
    let score = overlap * 0.65 + size_similarity * 0.2 + distance_score * 0.15;
    (score >= 0.3).then_some(score)
}

fn bounds_area(bounds: SemanticBounds) -> f32 {
    bounds.width.max(0.0) * bounds.height.max(0.0)
}

fn intersection_area(left: SemanticBounds, right: SemanticBounds) -> f32 {
    let x1 = left.x.max(right.x);
    let y1 = left.y.max(right.y);
    let x2 = (left.x + left.width).min(right.x + right.width);
    let y2 = (left.y + left.height).min(right.y + right.height);
    (x2 - x1).max(0.0) * (y2 - y1).max(0.0)
}

fn compare_documents(
    before: &PdfDocument<'_>,
    after: &PdfDocument<'_>,
    options: PiffOptions,
    started: Instant,
    load_ms: f64,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<PiffResult, PiffError> {
    ensure_not_cancelled(cancellation)?;
    let before_page_count = before.pages().len().max(0) as usize;
    let after_page_count = after.pages().len().max(0) as usize;
    let (page_pairs, fingerprint_ms, matching_ms) =
        build_page_pairs(before, after, options, progress, cancellation)?;
    let page_count = page_pairs.len();
    let mut pages = Vec::with_capacity(page_count);
    let mut role_evidence = DocumentRoleEvidence::default();
    let mut render_ms = 0.0;
    let mut compare_ms = 0.0;
    let mut region_ms = 0.0;
    let mut semantic_ms = 0.0;

    for (page_index, page_pair) in page_pairs.iter().copied().enumerate() {
        ensure_not_cancelled(cancellation)?;
        let before_page = page_pair
            .before
            .map(|page_index| before.pages().get(page_index as i32).map_err(pdfium_error))
            .transpose()?;
        let after_page = page_pair
            .after
            .map(|page_index| after.pages().get(page_index as i32).map_err(pdfium_error))
            .transpose()?;
        let before_size = before_page.as_ref().map(page_geometry);
        let after_size = after_page.as_ref().map(page_geometry);
        let render_started = Instant::now();
        let before_image = before_page
            .as_ref()
            .map(|page| {
                render_page(
                    page,
                    options.dpi,
                    cancellation,
                    options.limits.max_page_pixels,
                )
            })
            .transpose()?;
        let after_image = after_page
            .as_ref()
            .map(|page| {
                render_page(
                    page,
                    options.dpi,
                    cancellation,
                    options.limits.max_page_pixels,
                )
            })
            .transpose()?;
        render_ms += elapsed_ms(render_started);
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Rendering,
                completed: page_index + 1,
                total: page_count,
            },
        );

        let status = if page_pair.moved {
            PageStatus::Moved
        } else {
            match (before_image.is_some(), after_image.is_some()) {
                (true, true) => PageStatus::Modified,
                (true, false) => PageStatus::Deleted,
                (false, true) => PageStatus::Inserted,
                (false, false) => unreachable!("page count is the maximum of both documents"),
            }
        };
        let before_image = before_image.unwrap_or_else(|| {
            let image = after_image.as_ref().expect("an after page exists");
            RgbaImage::from_pixel(image.width(), image.height(), WHITE)
        });
        let after_image = after_image.unwrap_or_else(|| {
            RgbaImage::from_pixel(before_image.width(), before_image.height(), WHITE)
        });

        let compare_started = Instant::now();
        let diff_options = if matches!(status, PageStatus::Modified | PageStatus::Moved) {
            options.diff
        } else {
            DiffOptions {
                max_shift_px: 0,
                ..options.diff
            }
        };
        let page_diff =
            compare_images_with_cancellation(&before_image, &after_image, diff_options, || {
                is_cancelled(cancellation)
            })?;
        let figures = if page_diff.equal {
            Vec::new()
        } else if let (Some(before_page), Some(after_page)) =
            (before_page.as_ref(), after_page.as_ref())
        {
            compare_image_figures(before, before_page, after, after_page)
        } else {
            Vec::new()
        };
        let compare_elapsed_ms = elapsed_ms(compare_started);
        region_ms += page_diff.region_ms;
        compare_ms += (compare_elapsed_ms - page_diff.region_ms).max(0.0);

        let semantic_started = Instant::now();
        let semantic = if matches!(options.mode, PiffMode::Semantic) {
            Some(compare_semantic_pages(
                before,
                after,
                page_pair,
                options.reading_order,
                options.text_context_lines,
                cancellation,
                &mut role_evidence,
            )?)
        } else {
            None
        };
        semantic_ms += elapsed_ms(semantic_started);
        let semantic_equal = semantic.as_ref().map(|diff| diff.equal).unwrap_or(true);
        let geometry_equal = before_size == after_size;
        let warnings = page_warnings(
            page_pair,
            before_size,
            after_size,
            page_diff.alignment,
            page_diff.equal,
            &figures,
            semantic.as_ref(),
        );
        let status = match status {
            PageStatus::Modified | PageStatus::Moved
                if page_diff.equal
                    && semantic_equal
                    && geometry_equal
                    && figures.is_empty()
                    && !page_pair.moved =>
            {
                PageStatus::Equal
            }
            other => other,
        };
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Comparing,
                completed: page_index + 1,
                total: page_count,
            },
        );

        let preview = if options.include_previews {
            page_diff.preview
        } else {
            RgbaImage::new(0, 0)
        };
        pages.push(PdfPageDiff {
            before_page: page_pair.before,
            after_page: page_pair.after,
            status,
            before_size,
            after_size,
            width: page_diff.width,
            height: page_diff.height,
            changed_pixels: page_diff.changed_pixels,
            changed_ratio: page_diff.changed_ratio,
            alignment: page_diff.alignment,
            regions: page_diff.regions,
            figures,
            warnings,
            semantic,
            preview,
        });
    }

    if matches!(options.mode, PiffMode::Semantic) {
        annotate_document_block_roles(&mut pages, &role_evidence);
    }

    let equal = pages
        .iter()
        .all(|page| matches!(page.status, PageStatus::Equal));
    let text_diff =
        matches!(options.mode, PiffMode::Semantic).then(|| build_document_text_diff(&pages));
    Ok(PiffResult {
        schema_version: RESULT_SCHEMA_VERSION,
        engine: ENGINE_INFO,
        equal,
        before_page_count,
        after_page_count,
        pages,
        text_diff,
        stats: PiffStats {
            load_ms,
            fingerprint_ms,
            matching_ms,
            render_ms,
            compare_ms,
            region_ms,
            semantic_ms,
            total_ms: elapsed_ms(started),
        },
    })
}

fn record_role_evidence(
    evidence: &mut HashMap<(SemanticTextBlockRole, String), HashSet<usize>>,
    page_index: usize,
    runs: &[TextRun],
    page_size: PageGeometry,
) {
    for run in runs {
        let Some((role, key)) = role_candidate(run.text.as_str(), run.bounds, page_size) else {
            continue;
        };
        evidence.entry((role, key)).or_default().insert(page_index);
    }
}

fn annotate_document_block_roles(pages: &mut [PdfPageDiff], evidence: &DocumentRoleEvidence) {
    for page in pages {
        let before_page = page.before_page;
        let after_page = page.after_page;
        let before_size = page.before_size;
        let after_size = page.after_size;
        let Some(semantic) = page.semantic.as_mut() else {
            continue;
        };

        for block in &mut semantic.blocks {
            block.before_role = classify_block_role(
                block.before_text.as_deref(),
                block.before_bounds,
                before_size,
                before_page,
                &evidence.before,
            );
            block.after_role = classify_block_role(
                block.after_text.as_deref(),
                block.after_bounds,
                after_size,
                after_page,
                &evidence.after,
            );

            // A header or footer changed on one page will naturally stop being an
            // exact repeated string on that side. Carry the role across the match
            // when the replacement remains in the same edge band.
            if block.before_role == Some(SemanticTextBlockRole::Header)
                && block.after_role == Some(SemanticTextBlockRole::Body)
                && after_size
                    .zip(block.after_bounds)
                    .is_some_and(|(size, bounds)| {
                        edge_role(bounds, size) == Some(SemanticTextBlockRole::Header)
                    })
            {
                block.after_role = Some(SemanticTextBlockRole::Header);
            }
            if block.before_role == Some(SemanticTextBlockRole::Footer)
                && block.after_role == Some(SemanticTextBlockRole::Body)
                && after_size
                    .zip(block.after_bounds)
                    .is_some_and(|(size, bounds)| {
                        edge_role(bounds, size) == Some(SemanticTextBlockRole::Footer)
                    })
            {
                block.after_role = Some(SemanticTextBlockRole::Footer);
            }
            if block.after_role == Some(SemanticTextBlockRole::Header)
                && block.before_role == Some(SemanticTextBlockRole::Body)
                && before_size
                    .zip(block.before_bounds)
                    .is_some_and(|(size, bounds)| {
                        edge_role(bounds, size) == Some(SemanticTextBlockRole::Header)
                    })
            {
                block.before_role = Some(SemanticTextBlockRole::Header);
            }
            if block.after_role == Some(SemanticTextBlockRole::Footer)
                && block.before_role == Some(SemanticTextBlockRole::Body)
                && before_size
                    .zip(block.before_bounds)
                    .is_some_and(|(size, bounds)| {
                        edge_role(bounds, size) == Some(SemanticTextBlockRole::Footer)
                    })
            {
                block.before_role = Some(SemanticTextBlockRole::Footer);
            }
        }
    }
}

fn classify_block_role(
    text: Option<&str>,
    bounds: Option<SemanticBounds>,
    page_size: Option<PageGeometry>,
    page_index: Option<usize>,
    evidence: &HashMap<(SemanticTextBlockRole, String), HashSet<usize>>,
) -> Option<SemanticTextBlockRole> {
    let (Some(text), Some(bounds), Some(page_size), Some(page_index)) =
        (text, bounds, page_size, page_index)
    else {
        return text.map(|_| SemanticTextBlockRole::Body);
    };
    let Some(role) = edge_role(bounds, page_size) else {
        return Some(SemanticTextBlockRole::Body);
    };
    if repeated_role_text(text, role, page_index, evidence) {
        Some(role)
    } else {
        Some(SemanticTextBlockRole::Body)
    }
}

fn repeated_role_text(
    text: &str,
    role: SemanticTextBlockRole,
    _page_index: usize,
    evidence: &HashMap<(SemanticTextBlockRole, String), HashSet<usize>>,
) -> bool {
    let normalized = normalize_role_text(text);
    if normalized.is_empty() {
        return false;
    }
    let padded = format!(" {normalized} ");
    evidence.iter().any(|((candidate_role, key), pages)| {
        *candidate_role == role
            && pages.len() >= 2
            && (key == &normalized || padded.contains(&format!(" {key} ")))
    })
}

fn role_candidate(
    text: &str,
    bounds: SemanticBounds,
    page_size: PageGeometry,
) -> Option<(SemanticTextBlockRole, String)> {
    let role = edge_role(bounds, page_size)?;
    let key = normalize_role_text(text);
    let meaningful_characters = key
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count();
    if meaningful_characters < 4 || key.chars().count() > ROLE_MAX_TEXT_LENGTH {
        return None;
    }
    Some((role, key))
}

fn edge_role(bounds: SemanticBounds, page_size: PageGeometry) -> Option<SemanticTextBlockRole> {
    if page_size.height <= 0.0 || bounds.height <= 0.0 {
        return None;
    }
    let band = (page_size.height * ROLE_EDGE_BAND_RATIO)
        .max(ROLE_MIN_EDGE_BAND)
        .min(page_size.height * 0.3);
    // Semantic bounds use the PDFium text coordinate conversion used by this
    // crate: the page's visual top is near y=0 and its visual bottom is near
    // the page height.
    let at_top = bounds.y <= band;
    let at_bottom = bounds.y + bounds.height >= page_size.height - band;
    match (at_top, at_bottom) {
        (true, false) => Some(SemanticTextBlockRole::Header),
        (false, true) => Some(SemanticTextBlockRole::Footer),
        _ => None,
    }
}

fn normalize_role_text(text: &str) -> String {
    let mut normalized = String::new();
    let mut in_number = false;
    let mut pending_space = false;
    for character in text.chars() {
        if character.is_ascii_digit() {
            if !in_number {
                normalized.push('#');
                in_number = true;
            }
            continue;
        }
        in_number = false;
        if character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space && !normalized.ends_with(' ') {
            normalized.push(' ');
        }
        pending_space = false;
        normalized.extend(character.to_lowercase());
    }
    normalized.trim().to_owned()
}

fn build_document_text_diff(pages: &[PdfPageDiff]) -> PdfDocumentTextDiff {
    let mut changed_lines = 0;
    let mut truncated = false;
    let mut text_pages = Vec::new();
    let mut stream = Vec::new();

    for (page_index, page) in pages.iter().enumerate() {
        if matches!(page.status, PageStatus::Equal) {
            continue;
        }

        let text_diff = page.semantic.as_ref().map(|semantic| {
            changed_lines += semantic.text_diff.changed_lines;
            truncated |= semantic.changes_truncated || semantic.text_diff.truncated;
            semantic.text_diff.clone()
        });
        let blocks = page
            .semantic
            .as_ref()
            .map(|semantic| semantic.blocks.clone())
            .unwrap_or_default();
        stream.extend(
            blocks
                .iter()
                .map(|block| document_review_item(page_index, page, block)),
        );
        text_pages.push(PdfDocumentTextDiffPage {
            before_page: page.before_page,
            after_page: page.after_page,
            status: page.status,
            blocks,
            text_diff,
        });
    }

    PdfDocumentTextDiff {
        changed_lines,
        truncated,
        pages: text_pages,
        stream,
    }
}

fn document_review_item(
    page_index: usize,
    page: &PdfPageDiff,
    block: &piff_semantic::SemanticTextBlockDiff,
) -> PdfDocumentReviewItem {
    PdfDocumentReviewItem {
        id: format!("page-{page_index}-{}", block.id),
        page_index,
        before_page: page.before_page,
        after_page: page.after_page,
        page_status: page.status,
        block_id: block.id.clone(),
        kind: block.kind,
        structure: block.structure,
        confidence: block.confidence,
        before_text: block.before_text.clone(),
        after_text: block.after_text.clone(),
        before_bounds: block.before_bounds,
        after_bounds: block.after_bounds,
        before_focus_bounds: block.before_focus_bounds,
        after_focus_bounds: block.after_focus_bounds,
        before_role: block.before_role,
        after_role: block.after_role,
        text_diff: block.text_diff.clone(),
    }
}

fn page_warnings(
    page_pair: PagePair,
    before_size: Option<PageGeometry>,
    after_size: Option<PageGeometry>,
    alignment: Alignment,
    visual_equal: bool,
    figures: &[PdfFigureDiff],
    semantic: Option<&SemanticPageDiff>,
) -> Vec<PageWarning> {
    let mut warnings = Vec::new();
    if before_size.is_some() && after_size.is_some() && before_size != after_size {
        warnings.push(PageWarning::PageGeometryChanged);
    }
    if page_pair.before.is_some()
        && page_pair.after.is_some()
        && alignment.confidence < ALIGNMENT_WARNING_THRESHOLD
    {
        let high_confidence_reordering = figures.iter().any(|figure| {
            matches!(figure.status, FigureStatus::Moved | FigureStatus::Swapped)
                && figure.confidence >= 0.9
        });
        warnings.push(if high_confidence_reordering {
            PageWarning::ContentReordered
        } else {
            PageWarning::LowAlignmentConfidence
        });
    }
    if let Some(semantic) = semantic {
        if visual_equal && !semantic.equal {
            warnings.push(PageWarning::SemanticVisualDisagreement);
        }
        match semantic.quality {
            TextExtractionQuality::Empty => warnings.push(PageWarning::TextUnavailable),
            TextExtractionQuality::Partial => warnings.push(PageWarning::TextPartial),
            TextExtractionQuality::Suspect => warnings.push(PageWarning::TextSuspect),
            TextExtractionQuality::Text => {}
        }
        if semantic.text_diff.truncated {
            warnings.push(PageWarning::TextDiffTruncated);
        }
        if semantic.changes_truncated {
            warnings.push(PageWarning::TextChangesTruncated);
        }
    }
    warnings
}

fn build_page_pairs(
    before: &PdfDocument<'_>,
    after: &PdfDocument<'_>,
    options: PiffOptions,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<PagePair>, f64, f64), PiffError> {
    ensure_not_cancelled(cancellation)?;
    let before_page_count = before.pages().len().max(0) as usize;
    let after_page_count = after.pages().len().max(0) as usize;
    ensure_page_limit("before", before_page_count, options.limits.max_pages)?;
    ensure_page_limit("after", after_page_count, options.limits.max_pages)?;
    if matches!(options.page_matching, PageMatching::Index) {
        let page_count = before_page_count.max(after_page_count);
        return Ok((
            (0..page_count)
                .map(|page_index| PagePair {
                    before: (page_index < before_page_count).then_some(page_index),
                    after: (page_index < after_page_count).then_some(page_index),
                    moved: false,
                })
                .collect(),
            0.0,
            0.0,
        ));
    }

    let fingerprint_started = Instant::now();
    let before_fingerprints = render_fingerprints(
        before,
        before_page_count,
        progress,
        cancellation,
        options.limits.max_page_pixels,
    )?;
    let after_fingerprints = render_fingerprints(
        after,
        after_page_count,
        progress,
        cancellation,
        options.limits.max_page_pixels,
    )?;
    let fingerprint_ms = elapsed_ms(fingerprint_started);
    let matching_started = Instant::now();
    let pairs = pair_page_fingerprints(&before_fingerprints, &after_fingerprints);
    Ok((pairs, fingerprint_ms, elapsed_ms(matching_started)))
}

fn render_fingerprints(
    document: &PdfDocument<'_>,
    page_count: usize,
    progress: Option<&dyn Fn(ProgressEvent)>,
    cancellation: Option<&CancellationToken>,
    max_page_pixels: Option<u64>,
) -> Result<Vec<piff_core::PageFingerprint>, PiffError> {
    let mut fingerprints = Vec::with_capacity(page_count);
    for page_index in 0..page_count {
        ensure_not_cancelled(cancellation)?;
        let image = render_page(
            &document
                .pages()
                .get(page_index as i32)
                .map_err(pdfium_error)?,
            PAGE_FINGERPRINT_DPI,
            cancellation,
            max_page_pixels,
        )?;
        fingerprints.push(fingerprint_image(&image, PAGE_FINGERPRINT_SIZE));
        report_progress(
            progress,
            ProgressEvent {
                phase: ProgressPhase::Fingerprinting,
                completed: page_index + 1,
                total: page_count,
            },
        );
    }
    Ok(fingerprints)
}

fn report_progress(progress: Option<&dyn Fn(ProgressEvent)>, event: ProgressEvent) {
    if let Some(progress) = progress {
        progress(event);
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn is_cancelled(cancellation: Option<&CancellationToken>) -> bool {
    cancellation.is_some_and(CancellationToken::is_cancelled)
}

fn ensure_not_cancelled(cancellation: Option<&CancellationToken>) -> Result<(), PiffError> {
    if is_cancelled(cancellation) {
        Err(PiffError::Cancelled)
    } else {
        Ok(())
    }
}

fn compare_semantic_pages(
    before: &PdfDocument<'_>,
    after: &PdfDocument<'_>,
    page_pair: PagePair,
    reading_order: TextReadingOrder,
    text_context_lines: usize,
    cancellation: Option<&CancellationToken>,
    role_evidence: &mut DocumentRoleEvidence,
) -> Result<SemanticPageDiff, PiffError> {
    let (before_runs, before_extraction) = match page_pair.before {
        Some(page_index) => {
            let page = before
                .pages()
                .get(page_index as i32)
                .map_err(pdfium_error)?;
            let page_size = page_geometry(&page);
            let extracted = extract_text_runs(&page, reading_order, cancellation)?;
            record_role_evidence(
                &mut role_evidence.before,
                page_index,
                &extracted.0,
                page_size,
            );
            extracted
        }
        None => (Vec::new(), TextExtractionSummary::empty()),
    };
    let (after_runs, after_extraction) = match page_pair.after {
        Some(page_index) => {
            let page = after.pages().get(page_index as i32).map_err(pdfium_error)?;
            let page_size = page_geometry(&page);
            let extracted = extract_text_runs(&page, reading_order, cancellation)?;
            record_role_evidence(
                &mut role_evidence.after,
                page_index,
                &extracted.0,
                page_size,
            );
            extracted
        }
        None => (Vec::new(), TextExtractionSummary::empty()),
    };
    Ok(compare_runs_with_extraction_and_options(
        &before_runs,
        &after_runs,
        before_extraction,
        after_extraction,
        TextDiffOptions {
            context_lines: text_context_lines,
        },
    ))
}

fn extract_text_runs(
    page: &PdfPage<'_>,
    reading_order: TextReadingOrder,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<TextRun>, TextExtractionSummary), PiffError> {
    let page_height = page.height().value;
    let text = match page.text() {
        Ok(text) => text,
        Err(error) => {
            return Ok((
                Vec::new(),
                TextExtractionSummary::failed(truncate_error(error.to_string())),
            ))
        }
    };
    let mut runs = Vec::new();
    for segment in text.segments().iter() {
        ensure_not_cancelled(cancellation)?;
        let value = segment
            .text()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if value.is_empty() {
            continue;
        }
        let bounds = segment.bounds();
        let semantic_bounds = SemanticBounds::new(
            bounds.left().value,
            page_height - bounds.top().value,
            bounds.width().value,
            bounds.height().value,
        );
        runs.extend(
            extract_segment_word_runs(&segment, page_height)
                .unwrap_or_else(|| vec![TextRun::new(value, semantic_bounds)]),
        );
    }
    let replacement_char_count = runs
        .iter()
        .map(|run| {
            run.text
                .chars()
                .filter(|character| *character == '\u{FFFD}')
                .count()
        })
        .sum();
    let runs = normalize_text_runs_with_reading_order(&runs, reading_order);
    let summary = TextExtractionSummary::from_runs(&runs, replacement_char_count);
    Ok((runs, summary))
}

fn extract_segment_word_runs(
    segment: &PdfPageTextSegment<'_>,
    page_height: f32,
) -> Option<Vec<TextRun>> {
    let characters = segment.chars().ok()?;
    let segment_bounds = segment.bounds();
    let fallback_bounds = SemanticBounds::new(
        segment_bounds.left().value,
        page_height - segment_bounds.top().value,
        segment_bounds.width().value,
        segment_bounds.height().value,
    );
    let mut fragments = Vec::new();
    let mut word = String::new();
    let mut word_bounds = None;

    for character in characters.iter() {
        let value = character.unicode_string().unwrap_or_default();
        if value.chars().all(char::is_whitespace) {
            push_fragment(&mut fragments, &mut word, &mut word_bounds);
            continue;
        }
        let character_bounds = character
            .loose_bounds()
            .ok()
            .map(|bounds| {
                SemanticBounds::new(
                    bounds.left().value,
                    page_height - bounds.top().value,
                    bounds.width().value,
                    bounds.height().value,
                )
            })
            .unwrap_or(fallback_bounds);
        if is_punctuation_token(&value) {
            push_fragment(&mut fragments, &mut word, &mut word_bounds);
            fragments.push(TextFragment::new(value, character_bounds));
        } else {
            word.push_str(&value);
            word_bounds = Some(match word_bounds {
                Some(bounds) => union_semantic_bounds(bounds, character_bounds),
                None => character_bounds,
            });
        }
    }
    push_fragment(&mut fragments, &mut word, &mut word_bounds);

    (!fragments.is_empty()).then(|| {
        vec![TextRun::with_fragments(
            segment
                .text()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            fallback_bounds,
            fragments,
        )]
    })
}

fn push_fragment(
    fragments: &mut Vec<TextFragment>,
    word: &mut String,
    bounds: &mut Option<SemanticBounds>,
) {
    if word.is_empty() {
        *bounds = None;
        return;
    }
    if let Some(bounds) = bounds.take() {
        fragments.push(TextFragment::new(std::mem::take(word), bounds));
    }
}

fn is_punctuation_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_punctuation())
        && value != "'"
        && value != "-"
}

fn union_semantic_bounds(left: SemanticBounds, right: SemanticBounds) -> SemanticBounds {
    let right_edge = (left.x + left.width).max(right.x + right.width);
    let bottom = (left.y + left.height).max(right.y + right.height);
    let x = left.x.min(right.x);
    let y = left.y.min(right.y);
    SemanticBounds::new(x, y, right_edge - x, bottom - y)
}

fn truncate_error(message: String) -> String {
    const MAX_ERROR_LENGTH: usize = 256;
    let mut characters = message.chars();
    let truncated = characters
        .by_ref()
        .take(MAX_ERROR_LENGTH)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn with_pdfium<T>(
    library_path: Option<&Path>,
    operation: impl FnOnce(&Pdfium) -> Result<T, PiffError>,
) -> Result<T, PiffError> {
    let state = PDFIUM.get_or_init(|| create_pdfium(library_path).map(Mutex::new));
    let mutex = state
        .as_ref()
        .map_err(|error| PiffError::PdfiumBinding(error.clone()))?;
    let pdfium = mutex
        .lock()
        .map_err(|_| PiffError::PdfiumBinding("Pdfium mutex was poisoned".to_owned()))?;
    operation(&pdfium)
}

#[cfg(not(target_arch = "wasm32"))]
fn create_pdfium(library_path: Option<&Path>) -> Result<Pdfium, String> {
    let bindings = match library_path {
        Some(path) => Pdfium::bind_to_library(path),
        None => Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("."))
            .or_else(|_| Pdfium::bind_to_system_library()),
    }
    .map_err(|error| error.to_string())?;

    Ok(Pdfium::new(bindings))
}

#[cfg(target_arch = "wasm32")]
fn create_pdfium(_library_path: Option<&Path>) -> Result<Pdfium, String> {
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|error| error.to_string())
}

fn page_geometry(page: &PdfPage<'_>) -> PageGeometry {
    PageGeometry {
        width: page.width().value,
        height: page.height().value,
    }
}

fn render_page(
    page: &PdfPage<'_>,
    dpi: f32,
    cancellation: Option<&CancellationToken>,
    max_page_pixels: Option<u64>,
) -> Result<RgbaImage, PiffError> {
    ensure_not_cancelled(cancellation)?;
    let target_width_value = (page.width().value * dpi / 72.0).round().max(1.0);
    let target_height_value = (page.height().value * dpi / 72.0).round().max(1.0);
    if target_width_value > i32::MAX as f32 || target_height_value > i32::MAX as f32 {
        return Err(PiffError::PageDimensionsTooLarge);
    }
    let target_width = target_width_value as i32;
    let target_height = target_height_value as i32;
    ensure_page_pixels(target_width as u32, target_height as u32, max_page_pixels)?;
    if target_height <= MAX_RENDER_TILE_HEIGHT {
        let config = PdfRenderConfig::new()
            .set_target_width(target_width)
            .render_annotations(true)
            .render_form_data(true);
        let bitmap = page.render_with_config(&config).map_err(pdfium_error)?;
        ensure_not_cancelled(cancellation)?;
        let width = bitmap.width() as u32;
        let height = bitmap.height() as u32;
        ensure_page_pixels(width, height, max_page_pixels)?;
        return RgbaImage::from_raw(width, height, bitmap.as_rgba_bytes())
            .ok_or(PiffError::ImageConversion);
    }

    let width = target_width as u32;
    let height = target_height as u32;
    let mut output = RgbaImage::new(width, height);
    let tile_height = MAX_RENDER_TILE_HEIGHT.min(target_height);
    let mut bitmap = PdfBitmap::empty(width as i32, tile_height, PdfBitmapFormat::default())
        .map_err(pdfium_error)?;
    let row_bytes = width as usize * 4;

    for y_offset in (0..target_height).step_by(tile_height as usize) {
        ensure_not_cancelled(cancellation)?;
        let rows = tile_height.min(target_height - y_offset) as usize;
        let config = PdfRenderConfig::new()
            .set_fixed_size(target_width, target_height)
            .set_origin(0, -y_offset)
            .render_annotations(true)
            .render_form_data(true);
        page.render_into_bitmap_with_config(&mut bitmap, &config)
            .map_err(pdfium_error)?;
        let bytes = bitmap.as_rgba_bytes();
        let expected_bytes = rows * row_bytes;
        if bytes.len() < expected_bytes {
            return Err(PiffError::ImageConversion);
        }
        for row in 0..rows {
            ensure_not_cancelled(cancellation)?;
            let source_start = row * row_bytes;
            let destination_start = (y_offset as usize + row) * row_bytes;
            output.as_mut()[destination_start..destination_start + row_bytes]
                .copy_from_slice(&bytes[source_start..source_start + row_bytes]);
        }
    }

    Ok(output)
}

fn encode_png(image: RgbaImage) -> Result<Vec<u8>, PiffError> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| PiffError::PreviewEncoding(error.to_string()))?;
    Ok(output.into_inner())
}

#[cfg(not(target_arch = "wasm32"))]
fn load_pdf_from_file<'a>(
    pdfium: &'a Pdfium,
    path: &Path,
    password: Option<&str>,
    document: &'static str,
) -> Result<PdfDocument<'a>, PiffError> {
    pdfium
        .load_pdf_from_file(path, password)
        .map_err(|error| pdfium_load_error(error, document))
}

#[cfg(not(target_arch = "wasm32"))]
fn load_pdf_pair_from_files<'a>(
    pdfium: &'a Pdfium,
    before_path: &Path,
    after_path: &Path,
    passwords: PdfPasswords<'_>,
) -> Result<(PdfDocument<'a>, PdfDocument<'a>), PiffError> {
    let before = load_pdf_from_file(pdfium, before_path, passwords.before, "before")?;
    let after = load_pdf_from_file(pdfium, after_path, passwords.after, "after")?;
    Ok((before, after))
}

fn load_pdf_from_bytes<'a>(
    pdfium: &'a Pdfium,
    bytes: Vec<u8>,
    password: Option<&str>,
    document: &'static str,
) -> Result<PdfDocument<'a>, PiffError> {
    pdfium
        .load_pdf_from_byte_vec(bytes, password)
        .map_err(|error| pdfium_load_error(error, document))
}

fn load_pdf_pair_from_byte_slices<'a>(
    pdfium: &'a Pdfium,
    before_bytes: &'a [u8],
    after_bytes: &'a [u8],
    passwords: PdfPasswords<'_>,
) -> Result<(PdfDocument<'a>, PdfDocument<'a>), PiffError> {
    let before = pdfium
        .load_pdf_from_byte_slice(before_bytes, passwords.before)
        .map_err(|error| pdfium_load_error(error, "before"))?;
    let after = pdfium
        .load_pdf_from_byte_slice(after_bytes, passwords.after)
        .map_err(|error| pdfium_load_error(error, "after"))?;
    Ok((before, after))
}

fn is_encrypted(document: &PdfDocument<'_>) -> bool {
    // pdfium-render 0.9.3 only names revisions 2 through 4. Modern encrypted
    // files such as revision 6 therefore arrive as UnknownPdfSecurityHandlerRevision.
    // A loaded document returning anything other than Unprotected still needs the
    // protected-document retry path.
    !matches!(
        document.permissions().security_handler_revision(),
        Ok(PdfSecurityHandlerRevision::Unprotected)
    )
}

fn needs_encrypted_semantic_retry(
    options: PiffOptions,
    before: &PdfDocument<'_>,
    after: &PdfDocument<'_>,
) -> bool {
    matches!(options.mode, PiffMode::Semantic) && (is_encrypted(before) || is_encrypted(after))
}

fn add_retry_stats(result: &mut PiffResult, first: PiffStats) {
    result.stats.load_ms += first.load_ms;
    result.stats.fingerprint_ms += first.fingerprint_ms;
    result.stats.matching_ms += first.matching_ms;
    result.stats.render_ms += first.render_ms;
    result.stats.compare_ms += first.compare_ms;
    result.stats.region_ms += first.region_ms;
    result.stats.semantic_ms += first.semantic_ms;
}

fn pdfium_load_error(error: PdfiumError, document: &'static str) -> PiffError {
    match error {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            PiffError::PasswordRequired { document }
        }
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::SecurityError) => {
            PiffError::SecurityUnsupported { document }
        }
        error => pdfium_error(error),
    }
}

fn project_image(
    image: &RgbaImage,
    width: u32,
    height: u32,
    offset_x: i32,
    offset_y: i32,
) -> RgbaImage {
    let mut output = RgbaImage::from_pixel(width, height, WHITE);
    for y in 0..height {
        for x in 0..width {
            let source_x = i64::from(x) + i64::from(offset_x);
            let source_y = i64::from(y) + i64::from(offset_y);
            if source_x >= 0
                && source_y >= 0
                && source_x < i64::from(image.width())
                && source_y < i64::from(image.height())
            {
                output.put_pixel(x, y, *image.get_pixel(source_x as u32, source_y as u32));
            }
        }
    }
    output
}

fn pdfium_error(error: PdfiumError) -> PiffError {
    PiffError::Pdfium(error.to_string())
}

/// Returns the default artifact location used by the local spike's smoke-test command.
pub fn default_linux_pdfium_path() -> PathBuf {
    PathBuf::from("artifacts/pdfium/linux-x64/lib/libpdfium.so")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_limits_reject_zero_values() {
        let options = PiffOptions {
            limits: PdfResourceLimits {
                max_input_bytes: Some(0),
                ..PdfResourceLimits::default()
            },
            ..PiffOptions::default()
        };

        assert!(matches!(
            validate_options(options),
            Err(PiffError::InvalidMaxInputBytes)
        ));
    }

    #[test]
    fn text_diff_context_rejects_unbounded_values() {
        let options = PiffOptions {
            text_context_lines: MAX_TEXT_DIFF_CONTEXT_LINES + 1,
            ..PiffOptions::default()
        };

        assert!(matches!(
            validate_options(options),
            Err(PiffError::InvalidTextContextLines)
        ));
    }

    #[test]
    fn default_resource_limits_are_bounded() {
        let limits = PdfResourceLimits::default();

        assert_eq!(limits.max_input_bytes, Some(DEFAULT_MAX_INPUT_BYTES));
        assert_eq!(limits.max_pages, Some(DEFAULT_MAX_PAGES));
        assert_eq!(limits.max_page_pixels, Some(DEFAULT_MAX_PAGE_PIXELS));
        assert_eq!(PdfResourceLimits::unlimited().max_pages, None);
    }

    #[test]
    fn input_limit_rejects_each_document_independently() {
        let error = ensure_byte_input_limits(b"before", b"after", Some(5))
            .expect_err("the before input should exceed the limit");

        assert!(matches!(
            error,
            PiffError::InputTooLarge {
                document: "before",
                bytes: 6,
                max_bytes: 5,
            }
        ));
    }

    #[test]
    fn page_pixel_limit_rejects_large_renders() {
        let error = ensure_page_pixels(10, 10, Some(99))
            .expect_err("the render should exceed the pixel limit");

        assert!(matches!(
            error,
            PiffError::PagePixelsExceeded {
                width: 10,
                height: 10,
                pixels: 100,
                max_pixels: 99,
            }
        ));
    }

    #[test]
    fn password_load_errors_have_stable_classifications() {
        assert!(matches!(
            pdfium_load_error(
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError),
                "before"
            ),
            PiffError::PasswordRequired { document: "before" }
        ));
        assert!(matches!(
            pdfium_load_error(
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::SecurityError),
                "after"
            ),
            PiffError::SecurityUnsupported { document: "after" }
        ));
    }
}
