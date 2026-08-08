use std::collections::HashMap;
use std::env;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use piff_core::DiffOptions;
use piff_pdfium::{
    compare_bytes_with_passwords_and_progress, is_equal_bytes_with_passwords_and_progress,
    render_page_diff_png_with_passwords_and_cancellation, CancellationToken, PageMatching,
    PdfPasswords, PdfRenderRequest, PdfResourceLimits, PiffMode, PiffOptions, PiffResult,
    PreviewView, ProgressEvent, ProgressPhase,
};
use piff_semantic::TextReadingOrder;

type ProgressPayload = (String, u32, u32);
type ProgressCallback =
    ThreadsafeFunction<ProgressPayload, Unknown<'static>, ProgressPayload, Status, false, false, 0>;
type ProgressJsFunction = Function<'static, Unknown<'static>, Unknown<'static>>;

static CANCELLATION_TOKENS: OnceLock<Mutex<HashMap<u32, CancellationToken>>> = OnceLock::new();
static NEXT_CANCELLATION_TOKEN: AtomicU32 = AtomicU32::new(1);

#[derive(Debug, Default)]
#[napi(object)]
pub struct ResourceLimitsJs {
    pub max_input_bytes: Option<f64>,
    pub max_pages: Option<u32>,
    pub max_page_pixels: Option<f64>,
}

#[derive(Default)]
#[napi(object)]
pub struct DiffOptionsJs {
    pub dpi: Option<f64>,
    pub channel_tolerance: Option<u32>,
    pub changed_pixel_ratio: Option<f64>,
    pub max_shift_px: Option<u32>,
    pub alignment_sample_step: Option<u32>,
    pub min_region_area: Option<u32>,
    pub context_lines: Option<u32>,
    pub page_matching: Option<String>,
    pub mode: Option<String>,
    pub reading_order: Option<String>,
    pub password: Option<String>,
    pub before_password: Option<String>,
    pub after_password: Option<String>,
    pub limits: Option<ResourceLimitsJs>,
}

#[derive(Debug, Default)]
struct PasswordsOwned {
    before: Option<String>,
    after: Option<String>,
}

impl PasswordsOwned {
    fn as_refs(&self) -> PdfPasswords<'_> {
        PdfPasswords {
            before: self.before.as_deref(),
            after: self.after.as_deref(),
        }
    }
}

pub struct DiffTask {
    before: Vec<u8>,
    after: Vec<u8>,
    options: PiffOptions,
    passwords: PasswordsOwned,
    library_path: Option<PathBuf>,
    progress: Option<ProgressCallback>,
    cancellation: Option<CancellationToken>,
}

impl Task for DiffTask {
    type Output = PiffResult;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let before = std::mem::take(&mut self.before);
        let after = std::mem::take(&mut self.after);
        let library_path = self.library_path.as_deref();
        let progress = self.progress.as_ref().map(progress_callback);
        catch_unwind(AssertUnwindSafe(|| {
            compare_bytes_with_passwords_and_progress(
                before,
                after,
                library_path,
                self.options,
                self.passwords.as_refs(),
                progress.as_deref(),
                self.cancellation.as_ref(),
            )
            .map_err(|error| Error::from_reason(error.to_string()))
        }))
        .map_err(|payload| Error::from_reason(panic_message(payload)))?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        serde_json::to_string(&output).map_err(|error| {
            Error::from_reason(format!("could not serialize diff result: {error}"))
        })
    }
}

pub struct EqualTask {
    before: Vec<u8>,
    after: Vec<u8>,
    options: PiffOptions,
    passwords: PasswordsOwned,
    library_path: Option<PathBuf>,
    progress: Option<ProgressCallback>,
    cancellation: Option<CancellationToken>,
}

impl Task for EqualTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let before = std::mem::take(&mut self.before);
        let after = std::mem::take(&mut self.after);
        let library_path = self.library_path.as_deref();
        let progress = self.progress.as_ref().map(progress_callback);
        catch_unwind(AssertUnwindSafe(|| {
            is_equal_bytes_with_passwords_and_progress(
                before,
                after,
                library_path,
                self.options,
                self.passwords.as_refs(),
                progress.as_deref(),
                self.cancellation.as_ref(),
            )
            .map_err(|error| Error::from_reason(error.to_string()))
        }))
        .map_err(|payload| Error::from_reason(panic_message(payload)))?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct RenderPageTask {
    before: Vec<u8>,
    after: Vec<u8>,
    page_index: usize,
    options: PiffOptions,
    view: PreviewView,
    passwords: PasswordsOwned,
    library_path: Option<PathBuf>,
    cancellation: Option<CancellationToken>,
}

impl Task for RenderPageTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let before = std::mem::take(&mut self.before);
        let after = std::mem::take(&mut self.after);
        let library_path = self.library_path.as_deref();
        catch_unwind(AssertUnwindSafe(|| {
            render_page_diff_png_with_passwords_and_cancellation(
                before,
                after,
                self.page_index,
                library_path,
                self.options,
                self.view,
                PdfRenderRequest {
                    passwords: self.passwords.as_refs(),
                    cancellation: self.cancellation.as_ref(),
                },
            )
            .map_err(|error| Error::from_reason(error.to_string()))
        }))
        .map_err(|payload| Error::from_reason(panic_message(payload)))?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// Starts an off-thread PDF comparison from two Node or Bun Buffers.
#[napi]
pub fn piff(
    before: Buffer,
    after: Buffer,
    options: Option<DiffOptionsJs>,
    progress: Option<ProgressJsFunction>,
    signal: Option<AbortSignal>,
    cancellation_token: Option<u32>,
) -> napi::Result<AsyncTask<DiffTask>> {
    let cancellation = cancellation_for(cancellation_token)?;
    let (options, passwords) = split_options(options)?;
    Ok(AsyncTask::with_optional_signal(
        DiffTask {
            before: before.to_vec(),
            after: after.to_vec(),
            options,
            passwords,
            library_path: env::var_os("PDFIUM_LIBRARY_PATH").map(PathBuf::from),
            progress: progress_callback_from_js(progress)?,
            cancellation,
        },
        signal,
    ))
}

/// Starts an off-thread equality check that stops after the first changed page.
#[napi]
pub fn is_equal(
    before: Buffer,
    after: Buffer,
    options: Option<DiffOptionsJs>,
    progress: Option<ProgressJsFunction>,
    signal: Option<AbortSignal>,
    cancellation_token: Option<u32>,
) -> napi::Result<AsyncTask<EqualTask>> {
    let cancellation = cancellation_for(cancellation_token)?;
    let (options, passwords) = split_options(options)?;
    Ok(AsyncTask::with_optional_signal(
        EqualTask {
            before: before.to_vec(),
            after: after.to_vec(),
            options,
            passwords,
            library_path: env::var_os("PDFIUM_LIBRARY_PATH").map(PathBuf::from),
            progress: progress_callback_from_js(progress)?,
            cancellation,
        },
        signal,
    ))
}

/// Starts an off-thread PNG render for one page diff.
#[napi]
pub fn render_page_diff(
    before: Buffer,
    after: Buffer,
    page_index: u32,
    options: Option<DiffOptionsJs>,
    view: Option<String>,
    signal: Option<AbortSignal>,
    cancellation_token: Option<u32>,
) -> napi::Result<AsyncTask<RenderPageTask>> {
    let cancellation = cancellation_for(cancellation_token)?;
    let (options, passwords) = split_options(options)?;
    Ok(AsyncTask::with_optional_signal(
        RenderPageTask {
            before: before.to_vec(),
            after: after.to_vec(),
            page_index: page_index as usize,
            options,
            view: preview_view(view.as_deref())?,
            passwords,
            library_path: env::var_os("PDFIUM_LIBRARY_PATH").map(PathBuf::from),
            cancellation,
        },
        signal,
    ))
}

#[napi]
pub fn create_cancellation_token() -> napi::Result<u32> {
    let tokens = CANCELLATION_TOKENS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut tokens = tokens
        .lock()
        .map_err(|_| Error::from_reason("cancellation token registry was poisoned"))?;
    loop {
        let token_id = NEXT_CANCELLATION_TOKEN.fetch_add(1, Ordering::Relaxed);
        if token_id != 0 && !tokens.contains_key(&token_id) {
            tokens.insert(token_id, CancellationToken::new());
            return Ok(token_id);
        }
    }
}

#[napi]
pub fn cancel_cancellation_token(token_id: u32) -> napi::Result<()> {
    let tokens = CANCELLATION_TOKENS.get_or_init(|| Mutex::new(HashMap::new()));
    let tokens = tokens
        .lock()
        .map_err(|_| Error::from_reason("cancellation token registry was poisoned"))?;
    if let Some(token) = tokens.get(&token_id) {
        token.cancel();
    }
    Ok(())
}

#[napi]
pub fn release_cancellation_token(token_id: u32) -> napi::Result<()> {
    let tokens = CANCELLATION_TOKENS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut tokens = tokens
        .lock()
        .map_err(|_| Error::from_reason("cancellation token registry was poisoned"))?;
    tokens.remove(&token_id);
    Ok(())
}

fn preview_view(value: Option<&str>) -> napi::Result<PreviewView> {
    match value {
        None | Some("diff") => Ok(PreviewView::Diff),
        Some("before") => Ok(PreviewView::Before),
        Some("after") => Ok(PreviewView::After),
        Some(_) => Err(Error::from_reason(
            "preview view must be \"before\", \"after\", or \"diff\"",
        )),
    }
}

fn cancellation_for(token_id: Option<u32>) -> napi::Result<Option<CancellationToken>> {
    let Some(token_id) = token_id else {
        return Ok(None);
    };
    let tokens = CANCELLATION_TOKENS.get_or_init(|| Mutex::new(HashMap::new()));
    let tokens = tokens
        .lock()
        .map_err(|_| Error::from_reason("cancellation token registry was poisoned"))?;
    tokens
        .get(&token_id)
        .cloned()
        .ok_or_else(|| Error::from_reason(format!("unknown cancellation token {token_id}")))
        .map(Some)
}

fn progress_callback_from_js(
    callback: Option<ProgressJsFunction>,
) -> napi::Result<Option<ProgressCallback>> {
    callback
        .map(|callback| {
            callback
                .build_threadsafe_function::<ProgressPayload>()
                .build_callback(|context| Ok(context.value))
        })
        .transpose()
}

fn progress_callback(callback: &ProgressCallback) -> Box<dyn Fn(ProgressEvent) + '_> {
    Box::new(move |event| {
        let payload = (
            progress_phase(event.phase).to_owned(),
            event.completed.min(u32::MAX as usize) as u32,
            event.total.min(u32::MAX as usize) as u32,
        );
        let _ = callback.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
    })
}

fn progress_phase(phase: ProgressPhase) -> &'static str {
    match phase {
        ProgressPhase::Loading => "loading",
        ProgressPhase::Fingerprinting => "fingerprinting",
        ProgressPhase::Rendering => "rendering",
        ProgressPhase::Comparing => "comparing",
    }
}

fn split_options(options: Option<DiffOptionsJs>) -> napi::Result<(PiffOptions, PasswordsOwned)> {
    let options = options.unwrap_or_default();
    let before = options
        .before_password
        .clone()
        .or_else(|| options.password.clone());
    let after = options
        .after_password
        .clone()
        .or_else(|| options.password.clone());
    Ok((pdf_options(&options)?, PasswordsOwned { before, after }))
}

fn pdf_options(options: &DiffOptionsJs) -> napi::Result<PiffOptions> {
    let defaults = PiffOptions::default();
    if options
        .channel_tolerance
        .is_some_and(|value| value > u32::from(u8::MAX))
    {
        return Err(Error::from_reason(
            "channelTolerance must be between 0 and 255",
        ));
    }
    let page_matching = match options.page_matching.as_deref() {
        None | Some("index") => PageMatching::Index,
        Some("sequence") => PageMatching::Sequence,
        Some(value) => {
            return Err(Error::from_reason(format!(
                "pageMatching must be \"index\" or \"sequence\", got \"{value}\""
            )))
        }
    };
    let mode = match options.mode.as_deref() {
        None | Some("visual") => PiffMode::Visual,
        Some("semantic") => PiffMode::Semantic,
        Some(value) => {
            return Err(Error::from_reason(format!(
                "mode must be \"visual\" or \"semantic\", got \"{value}\""
            )))
        }
    };
    let reading_order = match options.reading_order.as_deref() {
        None | Some("auto") => TextReadingOrder::Auto,
        Some("rows") => TextReadingOrder::Rows,
        Some("columns") => TextReadingOrder::Columns,
        Some(value) => {
            return Err(Error::from_reason(format!(
                "readingOrder must be \"auto\", \"rows\", or \"columns\", got \"{value}\""
            )))
        }
    };
    Ok(PiffOptions {
        dpi: options
            .dpi
            .map(|value| value as f32)
            .unwrap_or(defaults.dpi),
        diff: DiffOptions {
            channel_tolerance: options
                .channel_tolerance
                .map(|value| value as u8)
                .unwrap_or(defaults.diff.channel_tolerance),
            changed_pixel_ratio: options
                .changed_pixel_ratio
                .map(|value| value as f32)
                .unwrap_or(defaults.diff.changed_pixel_ratio),
            max_shift_px: options.max_shift_px.unwrap_or(defaults.diff.max_shift_px),
            alignment_sample_step: options
                .alignment_sample_step
                .unwrap_or(defaults.diff.alignment_sample_step),
            min_region_area: options
                .min_region_area
                .map(|value| value as usize)
                .unwrap_or(defaults.diff.min_region_area),
        },
        page_matching,
        mode,
        reading_order,
        text_context_lines: options
            .context_lines
            .map(|value| value as usize)
            .unwrap_or(defaults.text_context_lines),
        include_previews: false,
        limits: resource_limits(options.limits.as_ref())?,
    })
}

fn resource_limits(limits: Option<&ResourceLimitsJs>) -> napi::Result<PdfResourceLimits> {
    let Some(limits) = limits else {
        return Ok(PdfResourceLimits::default());
    };
    let max_input_bytes = positive_limit(limits.max_input_bytes, "maxInputBytes")?
        .and_then(|value| usize::try_from(value).ok());
    if limits.max_input_bytes.is_some() && max_input_bytes.is_none() {
        return Err(Error::from_reason(
            "maxInputBytes is too large for this platform",
        ));
    }
    let max_page_pixels = positive_limit(limits.max_page_pixels, "maxPagePixels")?;
    Ok(PdfResourceLimits {
        max_input_bytes,
        max_pages: limits.max_pages.map(|value| value as usize),
        max_page_pixels,
    })
}

fn positive_limit(value: Option<f64>, name: &str) -> napi::Result<Option<u64>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
        return Err(Error::from_reason(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(Some(value as u64))
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown Rust panic".to_owned()
    }
}
