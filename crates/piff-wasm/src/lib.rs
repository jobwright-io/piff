use std::convert::TryFrom;
use std::panic::{catch_unwind, AssertUnwindSafe};

use piff_core::DiffOptions;
use piff_pdfium::{
    compare_bytes_with_passwords_and_progress, is_equal_bytes_with_passwords_and_progress,
    render_page_diff_png_with_passwords_and_cancellation, PageMatching, PdfPasswords,
    PdfRenderRequest, PdfResourceLimits, PiffError, PiffMode, PiffOptions, PreviewView, RenderMode,
};
use piff_semantic::TextReadingOrder;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Browser-facing options use the same camelCase names as the TypeScript API.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WasmDiffOptions {
    dpi: Option<f32>,
    page_matching: Option<String>,
    mode: Option<String>,
    render: Option<String>,
    reading_order: Option<String>,
    password: Option<String>,
    before_password: Option<String>,
    after_password: Option<String>,
    limits: Option<WasmResourceLimits>,
    channel_tolerance: Option<u32>,
    changed_pixel_ratio: Option<f32>,
    max_shift_px: Option<u32>,
    alignment_sample_step: Option<u32>,
    min_region_area: Option<u64>,
    context_lines: Option<u64>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WasmResourceLimits {
    max_input_bytes: Option<u64>,
    max_pages: Option<u64>,
    max_page_pixels: Option<u64>,
}

/// Compares two PDF byte buffers and returns the compact JSON diff result.
///
/// The generated WASM module also exposes pdfium-render's
/// `initialize_pdfium_render(pdfiumModule, localModule, debug)` function. The host must call
/// that function after loading its external PDFium WASM module and before calling this function.
#[wasm_bindgen]
pub fn piff(
    before: Vec<u8>,
    after: Vec<u8>,
    options_json: Option<String>,
) -> Result<String, JsValue> {
    catch_panic(|| {
        let (options, passwords) = parse_options(options_json)?;
        let result = compare_bytes_with_passwords_and_progress(
            before,
            after,
            None,
            options,
            passwords.as_refs(),
            None,
            None,
        )
        .map_err(error_value)?;
        serde_json::to_string(&result).map_err(|error| JsValue::from_str(&error.to_string()))
    })
}

/// Checks equality of two PDF byte buffers and stops after the first changed page.
#[wasm_bindgen]
pub fn is_equal(
    before: Vec<u8>,
    after: Vec<u8>,
    options_json: Option<String>,
) -> Result<bool, JsValue> {
    catch_panic(|| {
        let (options, passwords) = parse_options(options_json)?;
        is_equal_bytes_with_passwords_and_progress(
            before,
            after,
            None,
            options,
            passwords.as_refs(),
            None,
            None,
        )
        .map_err(error_value)
    })
}

/// Renders one page pair to a PNG on demand.
#[wasm_bindgen]
pub fn render_page_diff(
    before: Vec<u8>,
    after: Vec<u8>,
    page_index: u32,
    view: Option<String>,
    options_json: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    catch_panic(|| {
        let (options, passwords) = parse_options(options_json)?;
        render_page_diff_png_with_passwords_and_cancellation(
            before,
            after,
            page_index as usize,
            None,
            options,
            parse_view(view.as_deref())?,
            PdfRenderRequest {
                passwords: passwords.as_refs(),
                cancellation: None,
            },
        )
        .map_err(error_value)
    })
}

fn catch_panic<T>(operation: impl FnOnce() -> Result<T, JsValue>) -> Result<T, JsValue> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|payload| {
        Err(JsValue::from_str(&format!(
            "Rust panic: {}",
            panic_message(payload)
        )))
    })
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

fn parse_options(options_json: Option<String>) -> Result<(PiffOptions, PasswordsOwned), JsValue> {
    let options = options_json
        .map(|json| serde_json::from_str::<WasmDiffOptions>(&json))
        .transpose()
        .map_err(|error| JsValue::from_str(&format!("invalid PDF diff options: {error}")))?
        .unwrap_or_default();
    let before_password = options
        .before_password
        .clone()
        .or_else(|| options.password.clone());
    let after_password = options
        .after_password
        .clone()
        .or_else(|| options.password.clone());
    let defaults = PiffOptions::default();
    if options
        .channel_tolerance
        .is_some_and(|value| value > u32::from(u8::MAX))
    {
        return Err(JsValue::from_str(
            "channelTolerance must be between 0 and 255",
        ));
    }
    let page_matching = match options.page_matching.as_deref() {
        None | Some("index") => PageMatching::Index,
        Some("sequence") => PageMatching::Sequence,
        Some(value) => {
            return Err(JsValue::from_str(&format!(
                "pageMatching must be \"index\" or \"sequence\", got \"{value}\""
            )))
        }
    };
    let mode = match options.mode.as_deref() {
        None | Some("visual") => PiffMode::Visual,
        Some("semantic") => PiffMode::Semantic,
        Some(value) => {
            return Err(JsValue::from_str(&format!(
                "mode must be \"visual\" or \"semantic\", got \"{value}\""
            )))
        }
    };
    let render = match options.render.as_deref() {
        None | Some("full") => RenderMode::Full,
        Some("none") => RenderMode::None,
        Some(value) => {
            return Err(JsValue::from_str(&format!(
                "render must be \"full\" or \"none\", got \"{value}\""
            )))
        }
    };
    let reading_order = match options.reading_order.as_deref() {
        None | Some("auto") => TextReadingOrder::Auto,
        Some("rows") => TextReadingOrder::Rows,
        Some("columns") => TextReadingOrder::Columns,
        Some(value) => {
            return Err(JsValue::from_str(&format!(
                "readingOrder must be \"auto\", \"rows\", or \"columns\", got \"{value}\""
            )))
        }
    };
    let limits = options
        .limits
        .map(resource_limits)
        .transpose()?
        .unwrap_or_default();
    Ok((
        PiffOptions {
            dpi: options.dpi.unwrap_or(defaults.dpi),
            diff: DiffOptions {
                channel_tolerance: options
                    .channel_tolerance
                    .unwrap_or(u32::from(defaults.diff.channel_tolerance))
                    as u8,
                changed_pixel_ratio: options
                    .changed_pixel_ratio
                    .unwrap_or(defaults.diff.changed_pixel_ratio),
                max_shift_px: options.max_shift_px.unwrap_or(defaults.diff.max_shift_px),
                alignment_sample_step: options
                    .alignment_sample_step
                    .unwrap_or(defaults.diff.alignment_sample_step),
                min_region_area: options
                    .min_region_area
                    .map(usize::try_from)
                    .transpose()
                    .map_err(|_| JsValue::from_str("minRegionArea is too large for this platform"))?
                    .unwrap_or(defaults.diff.min_region_area),
            },
            page_matching,
            mode,
            render,
            reading_order,
            text_context_lines: options
                .context_lines
                .map(usize::try_from)
                .transpose()
                .map_err(|_| JsValue::from_str("contextLines is too large for this platform"))?
                .unwrap_or(defaults.text_context_lines),
            include_previews: false,
            limits,
        },
        PasswordsOwned {
            before: before_password,
            after: after_password,
        },
    ))
}

fn resource_limits(limits: WasmResourceLimits) -> Result<PdfResourceLimits, JsValue> {
    Ok(PdfResourceLimits {
        max_input_bytes: limits
            .max_input_bytes
            .map(usize::try_from)
            .transpose()
            .map_err(|_| JsValue::from_str("maxInputBytes is too large for this platform"))?,
        max_pages: limits
            .max_pages
            .map(usize::try_from)
            .transpose()
            .map_err(|_| JsValue::from_str("maxPages is too large for this platform"))?,
        max_page_pixels: limits.max_page_pixels,
    })
}

fn parse_view(view: Option<&str>) -> Result<PreviewView, JsValue> {
    match view {
        None | Some("diff") => Ok(PreviewView::Diff),
        Some("before") => Ok(PreviewView::Before),
        Some("after") => Ok(PreviewView::After),
        Some(value) => Err(JsValue::from_str(&format!(
            "view must be \"before\", \"after\", or \"diff\", got \"{value}\""
        ))),
    }
}

fn error_value(error: PiffError) -> JsValue {
    JsValue::from_str(&error.to_string())
}
