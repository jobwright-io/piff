#![no_main]

use std::path::PathBuf;
use std::sync::OnceLock;

use libfuzzer_sys::fuzz_target;
use piff_pdfium::{compare_bytes, PdfResourceLimits, PiffOptions};

const MAX_FUZZ_INPUT_BYTES: usize = 4 * 1024 * 1024;

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_FUZZ_INPUT_BYTES {
        return;
    }

    let Some(library_path) = pdfium_path().as_deref() else {
        return;
    };

    let mut options = PiffOptions::default();
    options.limits = PdfResourceLimits {
        max_input_bytes: Some(MAX_FUZZ_INPUT_BYTES),
        max_pages: Some(64),
        max_page_pixels: Some(4_000_000),
    };
    let _ = compare_bytes(data.to_vec(), data.to_vec(), Some(library_path), options);
});

fn pdfium_path() -> &'static Option<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| std::env::var_os("PDFIUM_LIBRARY_PATH").map(PathBuf::from))
}
