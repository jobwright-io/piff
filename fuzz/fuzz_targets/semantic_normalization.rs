#![no_main]

use libfuzzer_sys::fuzz_target;
use piff_semantic::{
    normalize_text_runs_with_reading_order, SemanticBounds, TextReadingOrder, TextRun,
};

const MAX_RUNS: usize = 64;
const RUN_BYTES: usize = 24;

fuzz_target!(|data: &[u8]| {
    let mut runs = Vec::with_capacity(data.len().div_ceil(RUN_BYTES).min(MAX_RUNS));
    for (index, chunk) in data.chunks(RUN_BYTES).take(MAX_RUNS).enumerate() {
        let text_start =
            usize::from(chunk.first().copied().unwrap_or_default()) % chunk.len().max(1);
        let text = String::from_utf8_lossy(&chunk[text_start..]).into_owned();
        let x = finite_coordinate(chunk.get(1).copied().unwrap_or_default());
        let y = finite_coordinate(chunk.get(2).copied().unwrap_or_default());
        let width = 1.0 + f32::from(chunk.get(3).copied().unwrap_or_default());
        let height = 1.0 + f32::from(chunk.get(4).copied().unwrap_or_default());
        let bounds = SemanticBounds::new(x + index as f32, y, width, height);
        runs.push(TextRun::new(text, bounds));
    }

    let reading_order = match data.first().copied().unwrap_or_default() % 3 {
        0 => TextReadingOrder::Auto,
        1 => TextReadingOrder::Rows,
        _ => TextReadingOrder::Columns,
    };
    let _ = normalize_text_runs_with_reading_order(&runs, reading_order);
});

fn finite_coordinate(value: u8) -> f32 {
    f32::from(value) * 4.0
}
