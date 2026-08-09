use std::fmt::Write as FmtWrite;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};
use piff_core::DiffOptions;
use piff_pdfium::{
    check_pdfium, compare_files_with_passwords, default_linux_pdfium_path, engine_info,
    is_equal_bytes_with_passwords_and_progress, PageMatching, PageStatus, PdfEngineInfo,
    PdfPasswords, PdfResourceLimits, PiffError, PiffMode, PiffOptions, PiffResult,
    RESULT_SCHEMA_VERSION,
};
use piff_semantic::{SemanticChangeKind, TextDiffLineKind, TextReadingOrder};
use serde::Serialize;
use thiserror::Error;

const EXIT_DIFFERENT: i32 = 1;
const EXIT_ERROR: i32 = 2;
const EXIT_CANCELLED: i32 = 130;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum PageMatchingArg {
    Index,
    Sequence,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum DiffModeArg {
    Visual,
    Semantic,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ReadingOrderArg {
    Auto,
    Rows,
    Columns,
}

#[derive(Debug, Parser)]
#[command(
    name = "piff",
    about = "Compare two PDF files through a Rust/PDFium pipeline"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Produce a complete page, region, figure, and optional semantic diff report.
    Compare(CompareCommand),
    /// Print a Git-like semantic text diff and exit 1 when the PDFs differ.
    Diff(DiffCommand),
    /// Stop at the first difference and return a CI-friendly equality result.
    Equal(EqualCommand),
    /// Verify that the configured PDFium backend can be loaded.
    Doctor(DoctorCommand),
}

#[derive(Debug, Args)]
struct CompareCommand {
    before: PathBuf,
    after: PathBuf,
    /// Compare rendered appearance only, or also compare positioned text.
    #[arg(long, value_enum, default_value_t = DiffModeArg::Visual)]
    mode: DiffModeArg,
    #[command(flatten)]
    settings: ComparisonSettings,
    /// Directory in which changed-page PNG previews are written.
    #[arg(long)]
    preview_dir: Option<PathBuf>,
    /// Write the JSON report to a file instead of stdout.
    #[arg(long)]
    output: Option<PathBuf>,
    /// Emit compact JSON instead of pretty-printed JSON.
    #[arg(long)]
    compact: bool,
    /// Exit with status 1 when the documents differ.
    #[arg(long)]
    fail_on_diff: bool,
}

#[derive(Debug, Args)]
struct DiffCommand {
    before: PathBuf,
    after: PathBuf,
    #[command(flatten)]
    settings: ComparisonSettings,
    /// Output a human-readable text diff or machine-readable JSON.
    #[arg(long, value_enum, default_value_t = DiffFormatArg::Text)]
    format: DiffFormatArg,
    /// Emit compact JSON when --format json is selected.
    #[arg(long, requires = "format", default_value_t = false)]
    compact: bool,
    /// Write the text diff to a file instead of stdout.
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum DiffFormatArg {
    Text,
    Json,
}

#[derive(Debug, Args)]
struct EqualCommand {
    before: PathBuf,
    after: PathBuf,
    /// Compare rendered appearance only, or also compare positioned text.
    #[arg(long, value_enum, default_value_t = DiffModeArg::Visual)]
    mode: DiffModeArg,
    #[command(flatten)]
    settings: ComparisonSettings,
    /// Write the equality JSON to a file instead of stdout.
    #[arg(long)]
    output: Option<PathBuf>,
    /// Emit compact JSON instead of pretty-printed JSON.
    #[arg(long)]
    compact: bool,
}

#[derive(Debug, Args)]
struct DoctorCommand {
    /// Path to a dynamically linked Pdfium library.
    #[arg(long, env = "PDFIUM_LIBRARY_PATH")]
    pdfium: Option<PathBuf>,
    /// Emit compact JSON instead of pretty-printed JSON.
    #[arg(long)]
    compact: bool,
}

#[derive(Debug, Args)]
struct ComparisonSettings {
    /// Path to a dynamically linked Pdfium library.
    #[arg(long, env = "PDFIUM_LIBRARY_PATH")]
    pdfium: Option<PathBuf>,
    /// Render resolution used for comparison.
    #[arg(long, default_value_t = 144.0)]
    dpi: f32,
    /// Per-channel absolute tolerance before a pixel is marked changed.
    #[arg(long, default_value_t = 8)]
    channel_tolerance: u8,
    /// Maximum changed-pixel ratio considered equal.
    #[arg(long, default_value_t = 0.0002)]
    changed_pixel_ratio: f32,
    /// Search this many pixels in each direction for translation alignment.
    #[arg(long, default_value_t = 8)]
    max_shift_px: u32,
    /// Sample every Nth pixel during translation alignment.
    #[arg(long, default_value_t = 8)]
    alignment_sample_step: u32,
    /// Pair pages by index or by low-resolution sequence alignment.
    #[arg(long, value_enum, default_value_t = PageMatchingArg::Index)]
    page_matching: PageMatchingArg,
    /// Interpret positioned text in automatic, row-major, or column-major order.
    #[arg(long, value_enum, default_value_t = ReadingOrderArg::Auto)]
    reading_order: ReadingOrderArg,
    /// Do not include connected regions smaller than this area.
    #[arg(long, default_value_t = 12)]
    min_region_area: usize,
    /// Number of unchanged text lines to keep around each changed block.
    #[arg(
        long,
        default_value_t = piff_semantic::DEFAULT_TEXT_DIFF_CONTEXT_LINES
    )]
    context_lines: usize,
    /// Shared password for both encrypted PDFs. Prefer PIFF_PASSWORD for automation.
    #[arg(
        long,
        env = "PIFF_PASSWORD",
        hide_env_values = true,
        conflicts_with_all = ["before_password", "after_password"]
    )]
    password: Option<String>,
    /// Password for the before PDF; falls back to --password.
    #[arg(
        long,
        env = "PIFF_BEFORE_PASSWORD",
        hide_env_values = true,
        conflicts_with = "password"
    )]
    before_password: Option<String>,
    /// Password for the after PDF; falls back to --password.
    #[arg(
        long,
        env = "PIFF_AFTER_PASSWORD",
        hide_env_values = true,
        conflicts_with = "password"
    )]
    after_password: Option<String>,
    /// Maximum bytes accepted for either input PDF.
    #[arg(long)]
    max_input_bytes: Option<usize>,
    /// Maximum pages accepted in either input PDF.
    #[arg(long)]
    max_pages: Option<usize>,
    /// Maximum rendered pixels accepted for one page.
    #[arg(long)]
    max_page_pixels: Option<u64>,
    /// Disable the default input, page-count, and raster-pixel limits.
    #[arg(long)]
    unlimited_resources: bool,
}

#[derive(Debug, Serialize)]
struct EqualityOutput {
    schema_version: u32,
    engine: PdfEngineInfo,
    equal: bool,
}

#[derive(Debug, Serialize)]
struct DoctorOutput {
    schema_version: u32,
    ok: bool,
    engine: PdfEngineInfo,
    library: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorOutput<'a> {
    error: ErrorDetails<'a>,
}

#[derive(Debug, Serialize)]
struct ErrorDetails<'a> {
    code: &'a str,
    message: &'a str,
}

#[derive(Debug, Error)]
enum CliError {
    #[error(transparent)]
    Engine(#[from] PiffError),
    #[error("could not read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("could not write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("could not write JSON output: {0}")]
    Json(#[from] serde_json::Error),
    #[error("could not write page preview {path}: {message}")]
    Preview { path: PathBuf, message: String },
    #[error("could not write stdout: {0}")]
    Stdout(#[from] io::Error),
}

impl CliError {
    fn code(&self) -> &'static str {
        match self {
            Self::Engine(error) => error.code(),
            Self::Read { .. } | Self::Write { .. } | Self::Stdout(_) => "io",
            Self::Json(_) => "serialization",
            Self::Preview { .. } => "preview-output",
        }
    }

    fn exit_code(&self) -> i32 {
        match self {
            Self::Engine(PiffError::Cancelled) => EXIT_CANCELLED,
            _ => EXIT_ERROR,
        }
    }
}

fn main() {
    let exit_code = match run() {
        Ok(exit_code) => exit_code,
        Err(error) => {
            write_error(&error);
            error.exit_code()
        }
    };
    std::process::exit(exit_code);
}

fn run() -> Result<i32, CliError> {
    let cli = Cli::parse();
    match cli.command {
        Command::Compare(command) => run_compare(command),
        Command::Diff(command) => run_diff(command),
        Command::Equal(command) => run_equal(command),
        Command::Doctor(command) => run_doctor(command),
    }
}

fn run_compare(command: CompareCommand) -> Result<i32, CliError> {
    let library_path = resolve_library_path(command.settings.pdfium.clone());
    let include_previews = command.preview_dir.is_some();
    let options = command.settings.to_options(include_previews, command.mode);
    let result = compare_files_with_passwords(
        &command.before,
        &command.after,
        library_path.as_deref(),
        options,
        command.settings.passwords(),
    )?;

    if let Some(preview_dir) = command.preview_dir {
        fs::create_dir_all(&preview_dir).map_err(|source| CliError::Write {
            path: preview_dir.clone(),
            source,
        })?;
        for (index, page) in result.pages.iter().enumerate() {
            let path = preview_dir.join(format!("page-{:04}.png", index + 1));
            page.preview
                .save(&path)
                .map_err(|error| CliError::Preview {
                    path,
                    message: error.to_string(),
                })?;
        }
    }

    write_json(&result, command.output.as_deref(), command.compact)?;
    Ok(if command.fail_on_diff && !result.equal {
        EXIT_DIFFERENT
    } else {
        0
    })
}

fn run_diff(command: DiffCommand) -> Result<i32, CliError> {
    let library_path = resolve_library_path(command.settings.pdfium.clone());
    let options = command.settings.to_options(false, DiffModeArg::Semantic);
    let result = compare_files_with_passwords(
        &command.before,
        &command.after,
        library_path.as_deref(),
        options,
        command.settings.passwords(),
    )?;
    match command.format {
        DiffFormatArg::Text => {
            let output = render_text_diff(&result, &command.before, &command.after);
            write_text(&output, command.output.as_deref())?;
        }
        DiffFormatArg::Json => {
            write_json(
                result
                    .text_diff
                    .as_ref()
                    .expect("semantic diff results include document text diff"),
                command.output.as_deref(),
                command.compact,
            )?;
        }
    }
    Ok(if result.equal { 0 } else { EXIT_DIFFERENT })
}

fn run_equal(command: EqualCommand) -> Result<i32, CliError> {
    let library_path = resolve_library_path(command.settings.pdfium.clone());
    let options = command.settings.to_options(false, command.mode);
    let before = read_input(&command.before)?;
    let after = read_input(&command.after)?;
    let equal = is_equal_bytes_with_passwords_and_progress(
        before,
        after,
        library_path.as_deref(),
        options,
        command.settings.passwords(),
        None,
        None,
    )?;
    let output = EqualityOutput {
        schema_version: RESULT_SCHEMA_VERSION,
        engine: engine_info(library_path.as_deref()),
        equal,
    };
    write_json(&output, command.output.as_deref(), command.compact)?;
    Ok(if equal { 0 } else { EXIT_DIFFERENT })
}

fn run_doctor(command: DoctorCommand) -> Result<i32, CliError> {
    let library_path = resolve_library_path(command.pdfium.clone());
    let engine = check_pdfium(library_path.as_deref())?;
    write_json(
        &DoctorOutput {
            schema_version: RESULT_SCHEMA_VERSION,
            ok: true,
            engine,
            library: library_path.map(|path| path.display().to_string()),
        },
        None,
        command.compact,
    )?;
    Ok(0)
}

impl ComparisonSettings {
    fn passwords(&self) -> PdfPasswords<'_> {
        PdfPasswords {
            before: self.before_password.as_deref().or(self.password.as_deref()),
            after: self.after_password.as_deref().or(self.password.as_deref()),
        }
    }

    fn to_options(&self, include_previews: bool, mode: DiffModeArg) -> PiffOptions {
        let default_limits = PdfResourceLimits::default();
        let limits = if self.unlimited_resources {
            PdfResourceLimits::unlimited()
        } else {
            PdfResourceLimits {
                max_input_bytes: self.max_input_bytes.or(default_limits.max_input_bytes),
                max_pages: self.max_pages.or(default_limits.max_pages),
                max_page_pixels: self.max_page_pixels.or(default_limits.max_page_pixels),
            }
        };
        PiffOptions {
            dpi: self.dpi,
            page_matching: match self.page_matching {
                PageMatchingArg::Index => PageMatching::Index,
                PageMatchingArg::Sequence => PageMatching::Sequence,
            },
            mode: match mode {
                DiffModeArg::Visual => PiffMode::Visual,
                DiffModeArg::Semantic => PiffMode::Semantic,
            },
            reading_order: match self.reading_order {
                ReadingOrderArg::Auto => TextReadingOrder::Auto,
                ReadingOrderArg::Rows => TextReadingOrder::Rows,
                ReadingOrderArg::Columns => TextReadingOrder::Columns,
            },
            text_context_lines: self.context_lines,
            diff: DiffOptions {
                channel_tolerance: self.channel_tolerance,
                changed_pixel_ratio: self.changed_pixel_ratio,
                max_shift_px: self.max_shift_px,
                alignment_sample_step: self.alignment_sample_step,
                min_region_area: self.min_region_area,
            },
            include_previews,
            limits,
        }
    }
}

fn render_text_diff(result: &PiffResult, before: &Path, after: &Path) -> String {
    let mut output = String::new();
    let mut wrote_header = false;

    for (page_index, page) in result.pages.iter().enumerate() {
        if matches!(page.status, PageStatus::Equal) {
            continue;
        }

        if !wrote_header {
            let _ = writeln!(output, "--- {}", before.display());
            let _ = writeln!(output, "+++ {}", after.display());
            wrote_header = true;
        }

        let before_page = page
            .before_page
            .map_or_else(|| "-".to_owned(), |value| (value + 1).to_string());
        let after_page = page
            .after_page
            .map_or_else(|| "-".to_owned(), |value| (value + 1).to_string());
        let _ = writeln!(
            output,
            "@@ page {} before={} after={} status={} @@",
            page_index + 1,
            before_page,
            after_page,
            page_status_label(page.status),
        );

        let stream_items = result
            .text_diff
            .as_ref()
            .map(|text_diff| {
                text_diff
                    .stream
                    .iter()
                    .filter(|item| item.page_index == page_index)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !stream_items.is_empty() {
            for item in stream_items {
                let _ = writeln!(
                    output,
                    "@@ block {} kind={} structure={:?} before={} after={} @@",
                    item.id,
                    semantic_change_label(item.kind),
                    item.structure,
                    item.before_page
                        .map_or_else(|| "-".to_owned(), |value| (value + 1).to_string()),
                    item.after_page
                        .map_or_else(|| "-".to_owned(), |value| (value + 1).to_string()),
                );
                for hunk in &item.text_diff.hunks {
                    let _ = writeln!(output, "@@ -{} +{} @@", hunk.before_start, hunk.after_start);
                    for line in &hunk.lines {
                        let prefix = match line.kind {
                            TextDiffLineKind::Context => ' ',
                            TextDiffLineKind::Added => '+',
                            TextDiffLineKind::Removed => '-',
                        };
                        let _ = writeln!(output, "{prefix}{}", render_inline_line(line));
                    }
                }
                if item.text_diff.truncated {
                    let _ = writeln!(output, "~ [block text diff truncated]");
                } else if item.text_diff.hunks.is_empty() {
                    write_review_item_summary(&mut output, item);
                }
            }
            continue;
        }

        let Some(semantic) = page.semantic.as_ref() else {
            write_page_summary(&mut output, page);
            continue;
        };
        for hunk in &semantic.text_diff.hunks {
            let _ = writeln!(output, "@@ -{} +{} @@", hunk.before_start, hunk.after_start);
            for line in &hunk.lines {
                let prefix = match line.kind {
                    TextDiffLineKind::Context => ' ',
                    TextDiffLineKind::Added => '+',
                    TextDiffLineKind::Removed => '-',
                };
                let _ = writeln!(output, "{prefix}{}", render_inline_line(line));
            }
        }
        if semantic.text_diff.truncated {
            let _ = writeln!(output, "~ [text diff truncated by resource limits]");
        } else if semantic.text_diff.hunks.is_empty() {
            write_page_summary(&mut output, page);
        }
    }

    output
}

fn semantic_change_label(kind: SemanticChangeKind) -> &'static str {
    match kind {
        SemanticChangeKind::Added => "added",
        SemanticChangeKind::Removed => "removed",
        SemanticChangeKind::Modified => "modified",
        SemanticChangeKind::Moved => "moved",
        SemanticChangeKind::Reflowed => "reflowed",
    }
}

fn write_review_item_summary(output: &mut String, item: &piff_pdfium::PdfDocumentReviewItem) {
    match item.kind {
        SemanticChangeKind::Added => {
            if let Some(text) = item.after_text.as_deref() {
                let _ = writeln!(output, "+{text}");
            }
        }
        SemanticChangeKind::Removed => {
            if let Some(text) = item.before_text.as_deref() {
                let _ = writeln!(output, "-{text}");
            }
        }
        SemanticChangeKind::Modified => {
            if let Some(text) = item.before_text.as_deref() {
                let _ = writeln!(output, "-{text}");
            }
            if let Some(text) = item.after_text.as_deref() {
                let _ = writeln!(output, "+{text}");
            }
        }
        SemanticChangeKind::Moved | SemanticChangeKind::Reflowed => {
            let _ = writeln!(output, "~ [{} block]", semantic_change_label(item.kind));
        }
    }
}

fn render_inline_line(line: &piff_semantic::TextDiffLine) -> String {
    let has_equal = line
        .spans
        .iter()
        .any(|span| span.kind == piff_semantic::TextDiffSpanKind::Equal);
    let has_change = line.spans.iter().any(|span| {
        matches!(
            span.kind,
            piff_semantic::TextDiffSpanKind::Added | piff_semantic::TextDiffSpanKind::Removed
        )
    });
    if !has_equal || !has_change {
        return line.text.replace(['\r', '\n'], "\\n");
    }

    line.spans
        .iter()
        .map(|span| {
            let text = span.text.replace(['\r', '\n'], "\\n");
            match span.kind {
                piff_semantic::TextDiffSpanKind::Equal => text,
                piff_semantic::TextDiffSpanKind::Added => mark_inline_change(&text, "{+", "+}"),
                piff_semantic::TextDiffSpanKind::Removed => mark_inline_change(&text, "[-", "-]"),
            }
        })
        .collect()
}

fn mark_inline_change(text: &str, opening: &str, closing: &str) -> String {
    let leading_len = text.len() - text.trim_start().len();
    let trailing_len = text.len() - text.trim_end().len();
    let core_end = text.len().saturating_sub(trailing_len);
    if leading_len >= core_end {
        return text.to_owned();
    }
    format!(
        "{}{}{}{}{}",
        &text[..leading_len],
        opening,
        &text[leading_len..core_end],
        closing,
        &text[core_end..],
    )
}

fn write_page_summary(output: &mut String, page: &piff_pdfium::PdfPageDiff) {
    match page.status {
        PageStatus::Inserted => {
            let _ = writeln!(output, "+ [page inserted]");
        }
        PageStatus::Deleted => {
            let _ = writeln!(output, "- [page deleted]");
        }
        PageStatus::Moved => {
            let _ = writeln!(output, "~ [page moved]");
        }
        PageStatus::Modified => {
            let _ = writeln!(
                output,
                "~ [visual change: {} pixels, {:.4}% of page]",
                page.changed_pixels,
                page.changed_ratio * 100.0,
            );
        }
        PageStatus::Equal => {}
    }
    if page.semantic.as_ref().is_some_and(|semantic| {
        semantic
            .changes
            .iter()
            .any(|change| change.kind == SemanticChangeKind::Reflowed)
    }) {
        let _ = writeln!(output, "~ [text reflowed; extracted words are unchanged]");
    }
    for figure in &page.figures {
        let _ = writeln!(output, "~ [figure {:?}: {}]", figure.status, figure.id);
    }
}

fn page_status_label(status: PageStatus) -> &'static str {
    match status {
        PageStatus::Equal => "equal",
        PageStatus::Modified => "modified",
        PageStatus::Inserted => "inserted",
        PageStatus::Deleted => "deleted",
        PageStatus::Moved => "moved",
    }
}

fn resolve_library_path(explicit: Option<PathBuf>) -> Option<PathBuf> {
    explicit.or_else(|| {
        let default_path = default_linux_pdfium_path();
        default_path.exists().then_some(default_path)
    })
}

fn read_input(path: &Path) -> Result<Vec<u8>, CliError> {
    fs::read(path).map_err(|source| CliError::Read {
        path: path.to_owned(),
        source,
    })
}

fn write_json<T: Serialize>(
    value: &T,
    output_path: Option<&Path>,
    compact: bool,
) -> Result<(), CliError> {
    let json = if compact {
        serde_json::to_string(value)?
    } else {
        serde_json::to_string_pretty(value)?
    };
    let json = format!("{json}\n");
    if let Some(path) = output_path {
        fs::write(path, json).map_err(|source| CliError::Write {
            path: path.to_owned(),
            source,
        })?;
        return Ok(());
    }

    let mut stdout = io::BufWriter::new(io::stdout().lock());
    if let Err(error) = stdout.write_all(json.as_bytes()) {
        if error.kind() == io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(CliError::Stdout(error));
    }
    if let Err(error) = stdout.flush() {
        if error.kind() == io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(CliError::Stdout(error));
    }
    Ok(())
}

fn write_text(value: &str, output_path: Option<&Path>) -> Result<(), CliError> {
    if let Some(path) = output_path {
        fs::write(path, value).map_err(|source| CliError::Write {
            path: path.to_owned(),
            source,
        })?;
        return Ok(());
    }

    let mut stdout = io::BufWriter::new(io::stdout().lock());
    if let Err(error) = stdout.write_all(value.as_bytes()) {
        if error.kind() == io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(CliError::Stdout(error));
    }
    if let Err(error) = stdout.flush() {
        if error.kind() == io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(CliError::Stdout(error));
    }
    Ok(())
}

fn write_error(error: &CliError) {
    let output = ErrorOutput {
        error: ErrorDetails {
            code: error.code(),
            message: &error.to_string(),
        },
    };
    match serde_json::to_string(&output) {
        Ok(json) => eprintln!("{json}"),
        Err(_) => eprintln!(
            "{{\"error\":{{\"code\":\"{}\",\"message\":\"{}\"}}}}",
            error.code(),
            error
        ),
    }
}
