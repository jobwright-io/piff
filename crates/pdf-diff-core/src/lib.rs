use std::collections::VecDeque;

use image::{Rgba, RgbaImage};
use serde::Serialize;
use thiserror::Error;

const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);
const MAX_ALIGNMENT_SHIFT_PX: u32 = 64;

/// Controls pixel tolerance and the small translation search used before comparison.
#[derive(Debug, Clone, Copy)]
pub struct DiffOptions {
    /// Maximum absolute difference allowed for each channel of a pixel.
    pub channel_tolerance: u8,
    /// A page is equal when its changed-pixel ratio is at or below this value.
    pub changed_pixel_ratio: f32,
    /// Searches all integer translations in this square around the origin. The runtime bounds
    /// this value at 64 pixels because exhaustive alignment grows quadratically.
    pub max_shift_px: u32,
    /// Samples every Nth pixel during translation search.
    pub alignment_sample_step: u32,
    /// Regions smaller than this are omitted from the region list but remain in aggregate counts.
    pub min_region_area: usize,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            channel_tolerance: 8,
            changed_pixel_ratio: 0.0002,
            max_shift_px: 8,
            alignment_sample_step: 8,
            min_region_area: 12,
        }
    }
}

#[derive(Debug, Error)]
pub enum DiffError {
    #[error("comparison was cancelled")]
    Cancelled,
    #[error("changed-pixel ratio must be between 0 and 1")]
    InvalidChangedPixelRatio,
    #[error("alignment sample step must be greater than zero")]
    InvalidAlignmentSampleStep,
    #[error("max alignment shift must be at most {MAX_ALIGNMENT_SHIFT_PX} pixels")]
    InvalidMaxShiftPx,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Alignment {
    pub offset_x: i32,
    pub offset_y: i32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct DiffBounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffRegion {
    pub id: String,
    pub bounds: DiffBounds,
    pub changed_pixels: u64,
    /// Changed pixels whose before-side sample contains visible page content.
    pub before_content_pixels: u64,
    /// Changed pixels whose after-side sample contains visible page content.
    pub after_content_pixels: u64,
}

#[derive(Debug)]
pub struct PageDiff {
    pub equal: bool,
    pub width: u32,
    pub height: u32,
    pub changed_pixels: u64,
    pub changed_ratio: f32,
    pub alignment: Alignment,
    pub regions: Vec<DiffRegion>,
    pub preview: RgbaImage,
}

/// A compact low-resolution representation used to pair pages before full rendering.
#[derive(Debug, Clone)]
pub struct PageFingerprint {
    width: u32,
    height: u32,
    samples: Vec<u8>,
}

/// A page pairing produced by sequence alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PagePair {
    pub before: Option<usize>,
    pub after: Option<usize>,
    pub moved: bool,
}

/// Creates a fixed-size RGB fingerprint while retaining the rendered page dimensions.
pub fn fingerprint_image(image: &RgbaImage, sample_size: u32) -> PageFingerprint {
    let sample_size = sample_size.max(1);
    let mut samples = Vec::with_capacity((sample_size * sample_size * 3) as usize);

    if image.width() == 0 || image.height() == 0 {
        samples.resize((sample_size * sample_size * 3) as usize, u8::MAX);
        return PageFingerprint {
            width: image.width(),
            height: image.height(),
            samples,
        };
    }

    for sample_y in 0..sample_size {
        for sample_x in 0..sample_size {
            let x = (u64::from(sample_x) * u64::from(image.width()) / u64::from(sample_size))
                .min(u64::from(image.width().saturating_sub(1))) as u32;
            let y = (u64::from(sample_y) * u64::from(image.height()) / u64::from(sample_size))
                .min(u64::from(image.height().saturating_sub(1))) as u32;
            let pixel = image.get_pixel(x, y);
            samples.extend_from_slice(&pixel.0[..3]);
        }
    }

    PageFingerprint {
        width: image.width(),
        height: image.height(),
        samples,
    }
}

/// Aligns two ordered fingerprint sequences and emits inserted, deleted, matched, and moved pages.
///
/// The matcher is deliberately conservative. A low-confidence diagonal match is represented
/// as a gap, which prevents one inserted cover from shifting every later page into a mismatch.
/// Very large page sequences fall back to index pairs to keep the dynamic-programming matrix
/// bounded.
pub fn pair_page_fingerprints(
    before: &[PageFingerprint],
    after: &[PageFingerprint],
) -> Vec<PagePair> {
    const MATCH_THRESHOLD: f32 = 0.82;
    const GAP_PENALTY: f32 = -0.35;
    const MAX_SEQUENCE_MATRIX_CELLS: usize = 4_000_000;

    if before
        .len()
        .saturating_add(1)
        .saturating_mul(after.len().saturating_add(1))
        > MAX_SEQUENCE_MATRIX_CELLS
    {
        return index_page_pairs(before.len(), after.len());
    }

    #[derive(Clone, Copy)]
    enum Direction {
        Start,
        Match,
        Delete,
        Insert,
    }

    let columns = after.len() + 1;
    let mut scores = vec![f32::NEG_INFINITY; (before.len() + 1) * columns];
    let mut directions = vec![Direction::Start; scores.len()];
    scores[0] = 0.0;

    for before_index in 0..=before.len() {
        for after_index in 0..=after.len() {
            let current = before_index * columns + after_index;
            if before_index == 0 && after_index == 0 {
                continue;
            }

            let mut best = (f32::NEG_INFINITY, Direction::Start, 3_u8);
            if before_index > 0 {
                let candidate = scores[(before_index - 1) * columns + after_index] + GAP_PENALTY;
                best = choose_alignment(best, (candidate, Direction::Delete, 1));
            }
            if after_index > 0 {
                let candidate = scores[before_index * columns + after_index - 1] + GAP_PENALTY;
                best = choose_alignment(best, (candidate, Direction::Insert, 2));
            }
            if before_index > 0 && after_index > 0 {
                let similarity =
                    fingerprint_similarity(&before[before_index - 1], &after[after_index - 1]);
                if similarity >= MATCH_THRESHOLD {
                    let candidate =
                        scores[(before_index - 1) * columns + after_index - 1] + similarity;
                    best = choose_alignment(best, (candidate, Direction::Match, 0));
                }
            }

            scores[current] = best.0;
            directions[current] = best.1;
        }
    }

    let mut pairs = Vec::with_capacity(before.len().max(after.len()));
    let (mut before_index, mut after_index) = (before.len(), after.len());
    while before_index > 0 || after_index > 0 {
        let direction = directions[before_index * columns + after_index];
        match direction {
            Direction::Match => {
                pairs.push(PagePair {
                    before: Some(before_index - 1),
                    after: Some(after_index - 1),
                    moved: false,
                });
                before_index -= 1;
                after_index -= 1;
            }
            Direction::Delete => {
                pairs.push(PagePair {
                    before: Some(before_index - 1),
                    after: None,
                    moved: false,
                });
                before_index -= 1;
            }
            Direction::Insert => {
                pairs.push(PagePair {
                    before: None,
                    after: Some(after_index - 1),
                    moved: false,
                });
                after_index -= 1;
            }
            Direction::Start => unreachable!("sequence alignment did not reach its origin"),
        }
    }
    pairs.reverse();
    if before.len() == after.len() {
        // With equal page counts, gaps that are only aligned to the same original index are
        // stronger evidence of a modified page than of a page insertion plus deletion. Keep
        // genuine cross-index matches available for reorder detection below.
        let has_gap = pairs
            .iter()
            .any(|pair| pair.before.is_none() || pair.after.is_none());
        let matched_pairs_are_index_aligned = pairs
            .iter()
            .filter(|pair| pair.before.is_some() && pair.after.is_some())
            .all(|pair| pair.before == pair.after);
        if has_gap && matched_pairs_are_index_aligned {
            return index_page_pairs(before.len(), after.len());
        }
    }
    coalesce_moved_pairs(&mut pairs, before, after);
    pairs
}

fn index_page_pairs(before_len: usize, after_len: usize) -> Vec<PagePair> {
    (0..before_len.max(after_len))
        .map(|page_index| PagePair {
            before: (page_index < before_len).then_some(page_index),
            after: (page_index < after_len).then_some(page_index),
            moved: false,
        })
        .collect()
}

fn coalesce_moved_pairs(
    pairs: &mut Vec<PagePair>,
    before: &[PageFingerprint],
    after: &[PageFingerprint],
) {
    const MOVED_THRESHOLD: f32 = 0.82;
    let mut moved_after = vec![false; after.len()];

    for before_pair_index in 0..pairs.len() {
        let Some(before_page) = pairs[before_pair_index].before else {
            continue;
        };
        if pairs[before_pair_index].after.is_some() {
            continue;
        }

        let best_after = pairs
            .iter()
            .filter_map(|pair| {
                let after_page = pair.after?;
                if pair.before.is_some() || moved_after[after_page] {
                    return None;
                }
                let similarity = fingerprint_similarity(&before[before_page], &after[after_page]);
                (similarity >= MOVED_THRESHOLD).then_some((similarity, after_page))
            })
            .max_by(|left, right| {
                left.0
                    .total_cmp(&right.0)
                    .then_with(|| right.1.cmp(&left.1))
            });

        if let Some((_, after_page)) = best_after {
            pairs[before_pair_index].after = Some(after_page);
            pairs[before_pair_index].moved = true;
            moved_after[after_page] = true;
        }
    }

    pairs.retain(|pair| {
        !(pair.before.is_none() && pair.after.is_some_and(|after_page| moved_after[after_page]))
    });
    mark_reordered_pairs(pairs);
}

fn mark_reordered_pairs(pairs: &mut [PagePair]) {
    for left_index in 0..pairs.len() {
        let Some(left_before) = pairs[left_index].before else {
            continue;
        };
        let Some(left_after) = pairs[left_index].after else {
            continue;
        };

        for right_index in left_index + 1..pairs.len() {
            let Some(right_before) = pairs[right_index].before else {
                continue;
            };
            let Some(right_after) = pairs[right_index].after else {
                continue;
            };
            if left_before < right_before && left_after > right_after {
                pairs[left_index].moved = true;
                pairs[right_index].moved = true;
            }
        }
    }
}

fn choose_alignment<T: Copy>(current: (f32, T, u8), candidate: (f32, T, u8)) -> (f32, T, u8) {
    if candidate.0 > current.0 + f32::EPSILON
        || ((candidate.0 - current.0).abs() <= f32::EPSILON && candidate.2 < current.2)
    {
        candidate
    } else {
        current
    }
}

fn fingerprint_similarity(before: &PageFingerprint, after: &PageFingerprint) -> f32 {
    let pixel_count = before.samples.len().min(after.samples.len()) / 3;
    let sample_count = pixel_count * 3;
    let pixel_similarity = if sample_count == 0 {
        1.0
    } else {
        let difference = before
            .samples
            .iter()
            .zip(after.samples.iter())
            .take(sample_count)
            .map(|(before, after)| u32::from(before.abs_diff(*after)))
            .sum::<u32>() as f32;
        1.0 - difference / (sample_count as f32 * f32::from(u8::MAX))
    };
    let (mut ink_intersection, mut ink_union) = (0_u32, 0_u32);
    for index in 0..pixel_count {
        let before_sample = &before.samples[index * 3..index * 3 + 3];
        let after_sample = &after.samples[index * 3..index * 3 + 3];
        let before_ink = sample_is_ink(before_sample);
        let after_ink = sample_is_ink(after_sample);
        if before_ink && after_ink {
            ink_intersection += 1;
        }
        if before_ink || after_ink {
            ink_union += 1;
        }
    }
    let ink_similarity = if ink_union == 0 {
        1.0
    } else {
        ink_intersection as f32 / ink_union as f32
    };
    let width_similarity = dimension_similarity(before.width, after.width);
    let height_similarity = dimension_similarity(before.height, after.height);
    (pixel_similarity * 0.55
        + ink_similarity * 0.35
        + ((width_similarity + height_similarity) / 2.0) * 0.10)
        .clamp(0.0, 1.0)
}

fn sample_is_ink(sample: &[u8]) -> bool {
    let luma =
        u32::from(sample[0]) * 2126 + u32::from(sample[1]) * 7152 + u32::from(sample[2]) * 722;
    luma < 245 * 10_000
}

fn dimension_similarity(before: u32, after: u32) -> f32 {
    let larger = before.max(after);
    if larger == 0 {
        1.0
    } else {
        before.min(after) as f32 / larger as f32
    }
}

/// Compares two rendered pages after searching for a small integer translation.
/// Missing pixels outside either image are treated as opaque white so page-size changes
/// become ordinary visual changes instead of a separate failure mode.
pub fn compare_images(
    before: &RgbaImage,
    after: &RgbaImage,
    options: DiffOptions,
) -> Result<PageDiff, DiffError> {
    compare_images_with_cancellation(before, after, options, || false)
}

/// Compares two rendered pages while allowing the caller to stop a long pixel pass.
pub fn compare_images_with_cancellation<F>(
    before: &RgbaImage,
    after: &RgbaImage,
    options: DiffOptions,
    is_cancelled: F,
) -> Result<PageDiff, DiffError>
where
    F: Fn() -> bool,
{
    validate_options(options)?;

    let width = before.width().max(after.width());
    let height = before.height().max(after.height());
    let alignment = find_alignment(before, after, width, height, options, &is_cancelled)?;
    let mut changed = vec![false; (width as usize) * (height as usize)];
    let mut before_content = vec![false; (width as usize) * (height as usize)];
    let mut after_content = vec![false; (width as usize) * (height as usize)];
    let mut preview = RgbaImage::new(width, height);
    let mut changed_pixels = 0_u64;

    for y in 0..height {
        if is_cancelled() {
            return Err(DiffError::Cancelled);
        }
        for x in 0..width {
            let before_pixel = pixel_or_white(before, x, y);
            let after_pixel = translated_pixel_or_white(after, x, y, alignment);
            let is_changed = pixel_changed(before_pixel, after_pixel, options.channel_tolerance);
            let index = (y * width + x) as usize;

            changed[index] = is_changed;
            before_content[index] = pixel_is_content(before_pixel);
            after_content[index] = pixel_is_content(after_pixel);
            if is_changed {
                changed_pixels += 1;
                preview.put_pixel(x, y, Rgba([235, 45, 55, 255]));
            } else {
                preview.put_pixel(x, y, faded_pixel(before_pixel));
            }
        }
    }

    if changed_pixels == 0 {
        preview = RgbaImage::from_pixel(width, height, WHITE);
    }

    let pixel_count = u64::from(width) * u64::from(height);
    let changed_ratio = if pixel_count == 0 {
        0.0
    } else {
        changed_pixels as f32 / pixel_count as f32
    };

    Ok(PageDiff {
        equal: changed_ratio <= options.changed_pixel_ratio,
        width,
        height,
        changed_pixels,
        changed_ratio,
        alignment,
        regions: find_regions(
            &changed,
            &before_content,
            &after_content,
            width,
            height,
            options.min_region_area,
            &is_cancelled,
        )?,
        preview,
    })
}

fn validate_options(options: DiffOptions) -> Result<(), DiffError> {
    if !(0.0..=1.0).contains(&options.changed_pixel_ratio) {
        return Err(DiffError::InvalidChangedPixelRatio);
    }
    if options.alignment_sample_step == 0 {
        return Err(DiffError::InvalidAlignmentSampleStep);
    }
    if options.max_shift_px > MAX_ALIGNMENT_SHIFT_PX {
        return Err(DiffError::InvalidMaxShiftPx);
    }
    Ok(())
}

fn alignment_candidate_is_better(candidate: (i32, i32, u64), current: (i32, i32, u64)) -> bool {
    if candidate.2 != current.2 {
        return candidate.2 < current.2;
    }

    let candidate_distance = candidate.0.unsigned_abs() + candidate.1.unsigned_abs();
    let current_distance = current.0.unsigned_abs() + current.1.unsigned_abs();
    candidate_distance < current_distance
        || (candidate_distance == current_distance
            && (candidate.1, candidate.0) < (current.1, current.0))
}

fn find_alignment(
    before: &RgbaImage,
    after: &RgbaImage,
    width: u32,
    height: u32,
    options: DiffOptions,
    is_cancelled: &impl Fn() -> bool,
) -> Result<Alignment, DiffError> {
    let max_shift = options.max_shift_px as i32;
    let mut best = (0_i32, 0_i32, u64::MAX);
    let mut worst_score = 0_u64;
    let context = AlignmentContext {
        before,
        after,
        width,
        height,
        options,
        is_cancelled,
    };

    for offset_y in -max_shift..=max_shift {
        for offset_x in -max_shift..=max_shift {
            let score = alignment_score(&context, offset_x, offset_y)?;
            worst_score = worst_score.max(score);
            if alignment_candidate_is_better((offset_x, offset_y, score), best) {
                best = (offset_x, offset_y, score);
            }
        }
    }

    let sample_count = sampled_pixel_count(width, height, options.alignment_sample_step);
    let confidence = if sample_count == 0 || worst_score == 0 {
        1.0
    } else {
        1.0 - best.2 as f32 / worst_score as f32
    };

    Ok(Alignment {
        offset_x: best.0,
        offset_y: best.1,
        confidence: confidence.clamp(0.0, 1.0),
    })
}

struct AlignmentContext<'a, F>
where
    F: Fn() -> bool,
{
    before: &'a RgbaImage,
    after: &'a RgbaImage,
    width: u32,
    height: u32,
    options: DiffOptions,
    is_cancelled: &'a F,
}

fn alignment_score<F>(
    context: &AlignmentContext<'_, F>,
    offset_x: i32,
    offset_y: i32,
) -> Result<u64, DiffError>
where
    F: Fn() -> bool,
{
    let step = context.options.alignment_sample_step;
    let mut score = 0_u64;

    for y in (0..context.height).step_by(step as usize) {
        if (context.is_cancelled)() {
            return Err(DiffError::Cancelled);
        }
        for x in (0..context.width).step_by(step as usize) {
            let before_pixel = pixel_or_white(context.before, x, y);
            let after_pixel = translated_pixel_or_white_at(context.after, x, y, offset_x, offset_y);
            if pixel_changed(before_pixel, after_pixel, context.options.channel_tolerance) {
                score += 1;
            }
        }
    }

    Ok(score)
}

fn sampled_pixel_count(width: u32, height: u32, step: u32) -> u64 {
    let x_count = (width.saturating_add(step - 1) / step) as u64;
    let y_count = (height.saturating_add(step - 1) / step) as u64;
    x_count * y_count
}

fn translated_pixel_or_white(image: &RgbaImage, x: u32, y: u32, alignment: Alignment) -> Rgba<u8> {
    translated_pixel_or_white_at(image, x, y, alignment.offset_x, alignment.offset_y)
}

fn translated_pixel_or_white_at(
    image: &RgbaImage,
    x: u32,
    y: u32,
    offset_x: i32,
    offset_y: i32,
) -> Rgba<u8> {
    let translated_x = x as i64 + i64::from(offset_x);
    let translated_y = y as i64 + i64::from(offset_y);
    if translated_x < 0
        || translated_y < 0
        || translated_x >= i64::from(image.width())
        || translated_y >= i64::from(image.height())
    {
        WHITE
    } else {
        *image.get_pixel(translated_x as u32, translated_y as u32)
    }
}

fn pixel_or_white(image: &RgbaImage, x: u32, y: u32) -> Rgba<u8> {
    image.get_pixel_checked(x, y).copied().unwrap_or(WHITE)
}

fn pixel_changed(before: Rgba<u8>, after: Rgba<u8>, tolerance: u8) -> bool {
    before
        .0
        .iter()
        .zip(after.0.iter())
        .any(|(before, after)| before.abs_diff(*after) > tolerance)
}

fn pixel_is_content(pixel: Rgba<u8>) -> bool {
    let luma = u32::from(pixel[0]) * 2126 + u32::from(pixel[1]) * 7152 + u32::from(pixel[2]) * 722;
    luma < 245 * 10_000
}

fn faded_pixel(pixel: Rgba<u8>) -> Rgba<u8> {
    Rgba([
        pixel[0] / 3 + 170,
        pixel[1] / 3 + 170,
        pixel[2] / 3 + 170,
        255,
    ])
}

fn find_regions(
    mask: &[bool],
    before_content: &[bool],
    after_content: &[bool],
    width: u32,
    height: u32,
    min_area: usize,
    is_cancelled: &impl Fn() -> bool,
) -> Result<Vec<DiffRegion>, DiffError> {
    let mut visited = vec![false; mask.len()];
    let mut regions = Vec::new();
    let directions = [
        (-1_i32, -1_i32),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    ];

    for y in 0..height {
        if is_cancelled() {
            return Err(DiffError::Cancelled);
        }
        for x in 0..width {
            let start = (y * width + x) as usize;
            if !mask[start] || visited[start] {
                continue;
            }

            let mut queue = VecDeque::from([(x, y)]);
            visited[start] = true;
            let mut area = 0_u64;
            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;
            let mut before_content_pixels = 0_u64;
            let mut after_content_pixels = 0_u64;

            while let Some((current_x, current_y)) = queue.pop_front() {
                if is_cancelled() {
                    return Err(DiffError::Cancelled);
                }
                area += 1;
                min_x = min_x.min(current_x);
                max_x = max_x.max(current_x);
                min_y = min_y.min(current_y);
                max_y = max_y.max(current_y);
                let current_index = (current_y * width + current_x) as usize;
                if before_content[current_index] {
                    before_content_pixels += 1;
                }
                if after_content[current_index] {
                    after_content_pixels += 1;
                }

                for (dx, dy) in directions {
                    let next_x = current_x as i32 + dx;
                    let next_y = current_y as i32 + dy;
                    if next_x < 0 || next_y < 0 || next_x >= width as i32 || next_y >= height as i32
                    {
                        continue;
                    }

                    let next_x = next_x as u32;
                    let next_y = next_y as u32;
                    let next_index = (next_y * width + next_x) as usize;
                    if mask[next_index] && !visited[next_index] {
                        visited[next_index] = true;
                        queue.push_back((next_x, next_y));
                    }
                }
            }

            if area >= min_area as u64 {
                regions.push(DiffRegion {
                    id: format!("region-{}", regions.len() + 1),
                    bounds: DiffBounds {
                        x: min_x,
                        y: min_y,
                        width: max_x - min_x + 1,
                        height: max_y - min_y + 1,
                    },
                    changed_pixels: area,
                    before_content_pixels,
                    after_content_pixels,
                });
            }
        }
    }

    Ok(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> DiffOptions {
        DiffOptions {
            channel_tolerance: 0,
            changed_pixel_ratio: 0.0,
            max_shift_px: 3,
            alignment_sample_step: 1,
            min_region_area: 1,
        }
    }

    #[test]
    fn identical_images_are_equal() {
        let image = RgbaImage::from_pixel(12, 8, Rgba([10, 20, 30, 255]));
        let result = compare_images(&image, &image, options()).unwrap();

        assert!(result.equal);
        assert_eq!(result.changed_pixels, 0);
        assert_eq!(result.alignment.offset_x, 0);
        assert_eq!(result.alignment.offset_y, 0);
        assert!(result.preview.pixels().all(|pixel| *pixel == WHITE));
    }

    #[test]
    fn blank_images_keep_zero_alignment() {
        let image = RgbaImage::from_pixel(12, 8, WHITE);
        let result = compare_images(&image, &image, options()).unwrap();

        assert_eq!(result.alignment.offset_x, 0);
        assert_eq!(result.alignment.offset_y, 0);
        assert_eq!(result.alignment.confidence, 1.0);
    }

    #[test]
    fn excessive_alignment_shift_is_rejected() {
        let mut diff_options = options();
        diff_options.max_shift_px = MAX_ALIGNMENT_SHIFT_PX + 1;
        let image = RgbaImage::from_pixel(4, 4, WHITE);

        assert!(matches!(
            compare_images(&image, &image, diff_options),
            Err(DiffError::InvalidMaxShiftPx)
        ));
    }

    #[test]
    fn translation_is_removed_before_comparison() {
        let before = RgbaImage::from_pixel(16, 12, WHITE);
        let mut after = before.clone();
        for y in 3..7 {
            for x in 4..8 {
                after.put_pixel(x + 2, y + 1, Rgba([0, 0, 0, 255]));
            }
        }
        let mut before_with_ink = before;
        for y in 3..7 {
            for x in 4..8 {
                before_with_ink.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }

        let result = compare_images(&before_with_ink, &after, options()).unwrap();

        assert!(result.equal);
        assert_eq!(result.changed_pixels, 0);
        assert_eq!(result.alignment.offset_x, 2);
        assert_eq!(result.alignment.offset_y, 1);
    }

    #[test]
    fn connected_changes_form_one_region() {
        let before = RgbaImage::from_pixel(10, 10, WHITE);
        let mut after = before.clone();
        after.put_pixel(4, 4, Rgba([0, 0, 0, 255]));
        after.put_pixel(5, 5, Rgba([0, 0, 0, 255]));

        let result = compare_images(&before, &after, options()).unwrap();

        assert!(!result.equal);
        assert_eq!(result.regions.len(), 1);
        assert_eq!(result.regions[0].changed_pixels, 2);
        assert_eq!(result.regions[0].before_content_pixels, 0);
        assert_eq!(result.regions[0].after_content_pixels, 2);
        assert_eq!(result.regions[0].bounds.width, 2);
    }

    #[test]
    fn content_counts_distinguish_visual_removal() {
        let after = RgbaImage::from_pixel(10, 10, WHITE);
        let mut before = after.clone();
        before.put_pixel(4, 4, Rgba([0, 0, 0, 255]));
        before.put_pixel(5, 5, Rgba([0, 0, 0, 255]));

        let result = compare_images(&before, &after, options()).unwrap();

        assert_eq!(result.regions.len(), 1);
        assert_eq!(result.regions[0].before_content_pixels, 2);
        assert_eq!(result.regions[0].after_content_pixels, 0);
    }

    #[test]
    fn cancellation_stops_before_pixel_work() {
        let image = RgbaImage::from_pixel(10, 10, WHITE);
        let error = compare_images_with_cancellation(&image, &image, options(), || true)
            .expect_err("the cancelled comparison should fail");

        assert!(matches!(error, DiffError::Cancelled));
    }

    #[test]
    fn sequence_pairing_preserves_pages_after_an_inserted_page() {
        let page = |color: (u8, u8, u8)| {
            RgbaImage::from_pixel(32, 32, Rgba([color.0, color.1, color.2, 255]))
        };
        let before = [page((255, 0, 0)), page((0, 255, 0))];
        let after = [page((0, 0, 255)), page((240, 0, 0)), page((0, 255, 0))];
        let before = before
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();
        let after = after
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();

        assert_eq!(
            pair_page_fingerprints(&before, &after),
            vec![
                PagePair {
                    before: None,
                    after: Some(0),
                    moved: false,
                },
                PagePair {
                    before: Some(0),
                    after: Some(1),
                    moved: false,
                },
                PagePair {
                    before: Some(1),
                    after: Some(2),
                    moved: false,
                },
            ]
        );
    }

    #[test]
    fn sequence_pairing_preserves_pages_after_a_deleted_page() {
        let page = |color: (u8, u8, u8)| {
            RgbaImage::from_pixel(32, 32, Rgba([color.0, color.1, color.2, 255]))
        };
        let before = [page((255, 0, 0)), page((0, 0, 255)), page((0, 255, 0))];
        let after = [page((245, 0, 0)), page((0, 255, 0))];
        let before = before
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();
        let after = after
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();

        assert_eq!(
            pair_page_fingerprints(&before, &after),
            vec![
                PagePair {
                    before: Some(0),
                    after: Some(0),
                    moved: false,
                },
                PagePair {
                    before: Some(1),
                    after: None,
                    moved: false,
                },
                PagePair {
                    before: Some(2),
                    after: Some(1),
                    moved: false,
                },
            ]
        );
    }

    #[test]
    fn sequence_pairing_keeps_a_page_pair_when_only_a_small_region_changes() {
        let page = |color: (u8, u8, u8)| {
            let mut image = RgbaImage::from_pixel(64, 64, WHITE);
            for y in 12..28 {
                for x in 10..54 {
                    image.put_pixel(x, y, Rgba([color.0, color.1, color.2, 255]));
                }
            }
            image
        };
        let before = [page((40, 40, 40)), page((40, 90, 140))];
        let mut changed = page((40, 40, 40));
        for y in 18..22 {
            for x in 24..32 {
                changed.put_pixel(x, y, Rgba([160, 40, 40, 255]));
            }
        }
        let after = [changed, page((40, 90, 140))];
        let before = before
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();
        let after = after
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();

        assert_eq!(
            pair_page_fingerprints(&before, &after),
            vec![
                PagePair {
                    before: Some(0),
                    after: Some(0),
                    moved: false,
                },
                PagePair {
                    before: Some(1),
                    after: Some(1),
                    moved: false,
                },
            ]
        );
    }

    #[test]
    fn equal_page_counts_fall_back_to_index_for_a_strong_page_change() {
        let before = vec![fingerprint_image(
            &RgbaImage::from_pixel(32, 32, Rgba([230, 20, 20, 255])),
            8,
        )];
        let after = vec![fingerprint_image(
            &RgbaImage::from_pixel(32, 32, Rgba([20, 20, 230, 255])),
            8,
        )];

        assert_eq!(
            pair_page_fingerprints(&before, &after),
            vec![PagePair {
                before: Some(0),
                after: Some(0),
                moved: false,
            }]
        );
    }

    #[test]
    fn oversized_sequence_matching_falls_back_to_index_pairs() {
        let fingerprint = PageFingerprint {
            width: 1,
            height: 1,
            samples: vec![255, 255, 255],
        };
        let before = vec![fingerprint.clone(); 2_001];
        let after = vec![fingerprint; 2_001];

        let pairs = pair_page_fingerprints(&before, &after);

        assert_eq!(pairs.len(), 2_001);
        assert!(pairs.iter().all(|pair| !pair.moved));
        assert_eq!(pairs[2_000].before, Some(2_000));
        assert_eq!(pairs[2_000].after, Some(2_000));
    }

    #[test]
    fn sequence_pairing_marks_reordered_pages_as_moved() {
        let page = |color: (u8, u8, u8)| {
            RgbaImage::from_pixel(32, 32, Rgba([color.0, color.1, color.2, 255]))
        };
        let before = [page((255, 0, 0)), page((0, 255, 0))];
        let after = [page((0, 255, 0)), page((255, 0, 0))];
        let before = before
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();
        let after = after
            .iter()
            .map(|image| fingerprint_image(image, 8))
            .collect::<Vec<_>>();

        let pairs = pair_page_fingerprints(&before, &after);

        assert_eq!(pairs.len(), 2);
        assert!(pairs.iter().all(|pair| pair.moved));
        assert_eq!(
            pairs.iter().map(|pair| pair.before).collect::<Vec<_>>(),
            vec![Some(0), Some(1)]
        );
        assert_eq!(
            pairs.iter().map(|pair| pair.after).collect::<Vec<_>>(),
            vec![Some(1), Some(0)]
        );
    }
}
