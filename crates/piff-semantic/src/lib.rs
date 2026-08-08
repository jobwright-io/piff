use serde::Serialize;

const POSITION_TOLERANCE: f32 = 1.5;
const MAX_SEMANTIC_MATCH_MATRIX_CELLS: usize = 4_000_000;
const MAX_SEMANTIC_CHANGES: usize = 4_096;
const MIN_COLUMN_GAP: f32 = 24.0;
const REFLOW_MIN_TOKEN_SIMILARITY: f32 = 0.75;
const REFLOW_MAX_LINE_SIMILARITY: f32 = 0.65;
pub const DEFAULT_TEXT_DIFF_CONTEXT_LINES: usize = 3;
pub const MAX_TEXT_DIFF_CONTEXT_LINES: usize = 100;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct SemanticBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl SemanticBounds {
    pub const fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn center_x(self) -> f32 {
        self.x + self.width / 2.0
    }

    fn center_y(self) -> f32 {
        self.y + self.height / 2.0
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextFragment {
    pub text: String,
    pub bounds: SemanticBounds,
}

impl TextFragment {
    pub fn new(text: impl Into<String>, bounds: SemanticBounds) -> Self {
        Self {
            text: text.into(),
            bounds,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub bounds: SemanticBounds,
    pub fragments: Vec<TextFragment>,
}

/// Policy used to turn positioned text lines into a semantic reading sequence.
///
/// `Auto` uses conservative column evidence, `Rows` keeps row-major order, and
/// `Columns` opts into a less conservative column split when the page contains
/// a clear horizontal separator.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextReadingOrder {
    #[default]
    Auto,
    Rows,
    Columns,
}

impl TextRun {
    pub fn new(text: impl Into<String>, bounds: SemanticBounds) -> Self {
        let text = text.into();
        Self {
            fragments: vec![TextFragment::new(text.clone(), bounds)],
            text,
            bounds,
        }
    }

    pub fn with_fragments(
        text: impl Into<String>,
        bounds: SemanticBounds,
        fragments: Vec<TextFragment>,
    ) -> Self {
        Self {
            text: text.into(),
            bounds,
            fragments,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextExtractionStatus {
    Empty,
    Text,
    Suspect,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextExtractionQuality {
    Empty,
    Text,
    Partial,
    Suspect,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TextExtractionSummary {
    pub status: TextExtractionStatus,
    pub run_count: usize,
    pub char_count: usize,
    pub replacement_char_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TextExtractionSummary {
    pub const fn empty() -> Self {
        Self {
            status: TextExtractionStatus::Empty,
            run_count: 0,
            char_count: 0,
            replacement_char_count: 0,
            error: None,
        }
    }

    pub fn from_runs(runs: &[TextRun], replacement_char_count: usize) -> Self {
        let char_count = runs.iter().map(|run| run.text.chars().count()).sum();
        Self {
            status: if runs.is_empty() {
                TextExtractionStatus::Empty
            } else if replacement_char_count > 0 {
                TextExtractionStatus::Suspect
            } else {
                TextExtractionStatus::Text
            },
            run_count: runs.len(),
            char_count,
            replacement_char_count,
            error: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            status: TextExtractionStatus::Suspect,
            run_count: 0,
            char_count: 0,
            replacement_char_count: 0,
            error: Some(message.into()),
        }
    }
}

/// Reconstructs reading lines from PDFium's positioned text segments.
///
/// PDFium segment boundaries are renderer artifacts: one source line may be split into
/// several words, glyph groups, or spans with different fonts. This pass makes the semantic
/// diff stable across those boundaries while retaining the union bounds for visual linking.
pub fn normalize_text_runs(runs: &[TextRun]) -> Vec<TextRun> {
    normalize_text_runs_with_reading_order(runs, TextReadingOrder::Auto)
}

/// Reconstructs reading lines using an explicit reading-order policy.
pub fn normalize_text_runs_with_reading_order(
    runs: &[TextRun],
    reading_order: TextReadingOrder,
) -> Vec<TextRun> {
    let segments = runs
        .iter()
        .filter_map(|run| {
            let text = normalize_whitespace(&run.text);
            if text.is_empty() {
                None
            } else {
                let fragments = if run.fragments.is_empty() {
                    vec![TextFragment::new(text.clone(), run.bounds)]
                } else {
                    run.fragments.clone()
                };
                Some(TextRun::with_fragments(text, run.bounds, fragments))
            }
        })
        .collect::<Vec<_>>();
    let mut line_groups = Vec::<Vec<TextRun>>::new();
    for segment in segments {
        let candidate = line_groups
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                line.iter()
                    .any(|existing| same_text_line(existing.bounds, segment.bounds))
            })
            .min_by(|(_, left), (_, right)| {
                line_distance_to_segment(left, segment.bounds)
                    .total_cmp(&line_distance_to_segment(right, segment.bounds))
            })
            .map(|(index, _)| index);

        if let Some(index) = candidate {
            line_groups[index].push(segment);
        } else {
            line_groups.push(vec![segment]);
        }
    }

    let lines = line_groups
        .into_iter()
        .map(|mut line| {
            line.sort_by(|left, right| left.bounds.x.total_cmp(&right.bounds.x));
            let first = line.first().expect("line groups are never empty");
            let (text, bounds, fragments) = line.iter().skip(1).fold(
                (first.text.clone(), first.bounds, first.fragments.clone()),
                |(text, bounds, mut fragments), segment| {
                    fragments.extend(segment.fragments.clone());
                    (
                        join_line_text(&text, &segment.text),
                        union_bounds(bounds, segment.bounds),
                        fragments,
                    )
                },
            );
            TextRun::with_fragments(text, bounds, fragments)
        })
        .collect::<Vec<_>>();
    order_reading_lines(lines, reading_order)
}

fn order_reading_lines(mut lines: Vec<TextRun>, reading_order: TextReadingOrder) -> Vec<TextRun> {
    sort_reading_lines(&mut lines);
    let split = match reading_order {
        TextReadingOrder::Rows => None,
        TextReadingOrder::Auto => find_column_split(&lines, true),
        TextReadingOrder::Columns => find_column_split(&lines, false),
    };
    let Some(split) = split else {
        return lines;
    };

    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut spanning = Vec::new();
    for line in lines {
        let line_right = line.bounds.x + line.bounds.width;
        if line_right <= split {
            left.push(line);
        } else if line.bounds.x >= split {
            right.push(line);
        } else {
            spanning.push(line);
        }
    }
    if left.len() < 2 || right.len() < 2 {
        return left.into_iter().chain(spanning).chain(right).collect();
    }

    sort_reading_lines(&mut left);
    sort_reading_lines(&mut right);
    sort_reading_lines(&mut spanning);
    let first_column_y = left
        .iter()
        .chain(right.iter())
        .map(|line| line.bounds.center_y())
        .min_by(f32::total_cmp)
        .unwrap_or_default();
    let last_column_y = left
        .iter()
        .chain(right.iter())
        .map(|line| line.bounds.center_y())
        .max_by(f32::total_cmp)
        .unwrap_or_default();
    let mut leading = Vec::new();
    let mut middle = Vec::new();
    let mut trailing = Vec::new();
    for line in spanning {
        let center_y = line.bounds.center_y();
        if center_y <= first_column_y {
            leading.push(line);
        } else if center_y > last_column_y {
            trailing.push(line);
        } else {
            middle.push(line);
        }
    }

    leading
        .into_iter()
        .chain(left)
        .chain(middle)
        .chain(right)
        .chain(trailing)
        .collect()
}

fn sort_reading_lines(lines: &mut [TextRun]) {
    lines.sort_by(|left, right| {
        left.bounds
            .center_y()
            .total_cmp(&right.bounds.center_y())
            .then_with(|| left.bounds.x.total_cmp(&right.bounds.x))
    });
}

fn find_column_split(lines: &[TextRun], conservative: bool) -> Option<f32> {
    if lines.len() < if conservative { 4 } else { 2 } {
        return None;
    }
    let mut endpoints = lines
        .iter()
        .flat_map(|line| [line.bounds.x, line.bounds.x + line.bounds.width])
        .collect::<Vec<_>>();
    endpoints.sort_by(f32::total_cmp);
    endpoints.dedup_by(|left, right| (*left - *right).abs() < 0.5);

    let mut best: Option<(usize, f32, f32)> = None;
    for window in endpoints.windows(2) {
        let [left_edge, right_edge] = window else {
            continue;
        };
        let gap = right_edge - left_edge;
        if gap < MIN_COLUMN_GAP {
            continue;
        }
        let split = (left_edge + right_edge) / 2.0;
        let left_count = lines
            .iter()
            .filter(|line| line.bounds.x + line.bounds.width <= split)
            .count();
        let right_count = lines.iter().filter(|line| line.bounds.x >= split).count();
        let spanning_count = lines.len().saturating_sub(left_count + right_count);
        let minimum_side_count = if conservative { 2 } else { 1 };
        let maximum_spanning_count = if conservative {
            lines.len() / 4
        } else {
            lines.len() / 2
        };
        if left_count < minimum_side_count
            || right_count < minimum_side_count
            || spanning_count > maximum_spanning_count
        {
            continue;
        }
        let score = left_count.min(right_count);
        let candidate = (score, gap, split);
        if best.map_or(true, |current| {
            candidate.0 > current.0 || (candidate.0 == current.0 && candidate.1 > current.1)
        }) {
            best = Some(candidate);
        }
    }
    best.map(|(_, _, split)| split)
}

fn normalize_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_text_line(left: SemanticBounds, right: SemanticBounds) -> bool {
    let left_top = left.y + left.height;
    let right_top = right.y + right.height;
    let overlap = (left_top.min(right_top) - left.y.max(right.y)).max(0.0);
    let min_height = left.height.min(right.height).max(1.0);
    let center_delta = (left.center_y() - right.center_y()).abs();
    let vertical_match = overlap / min_height >= 0.35 || center_delta <= min_height * 0.7;
    if !vertical_match {
        return false;
    }

    let horizontal_gap = if right.x >= left.x + left.width {
        right.x - (left.x + left.width)
    } else if left.x >= right.x + right.width {
        left.x - (right.x + right.width)
    } else {
        0.0
    };
    horizontal_gap <= (min_height * 8.0).max(32.0)
}

fn line_distance(left: SemanticBounds, right: SemanticBounds) -> f32 {
    (left.center_y() - right.center_y()).abs()
}

fn line_distance_to_segment(line: &[TextRun], segment: SemanticBounds) -> f32 {
    line.iter()
        .map(|run| line_distance(run.bounds, segment))
        .fold(f32::INFINITY, f32::min)
}

fn union_bounds(left: SemanticBounds, right: SemanticBounds) -> SemanticBounds {
    let right_edge = (left.x + left.width).max(right.x + right.width);
    let top = (left.y + left.height).max(right.y + right.height);
    let x = left.x.min(right.x);
    let y = left.y.min(right.y);
    SemanticBounds::new(x, y, right_edge - x, top - y)
}

fn changed_focus_bounds(
    before: &TextRun,
    after: &TextRun,
) -> (Option<SemanticBounds>, Option<SemanticBounds>) {
    let before_fragments = effective_fragments(before);
    let after_fragments = effective_fragments(after);
    let prefix = before_fragments
        .iter()
        .zip(after_fragments.iter())
        .take_while(|(left, right)| left.text == right.text)
        .count();
    let suffix = before_fragments
        .iter()
        .rev()
        .zip(after_fragments.iter().rev())
        .take_while(|(left, right)| left.text == right.text)
        .count()
        .min(before_fragments.len().saturating_sub(prefix))
        .min(after_fragments.len().saturating_sub(prefix));
    let before_end = before_fragments.len().saturating_sub(suffix);
    let after_end = after_fragments.len().saturating_sub(suffix);
    let before_focus = fragment_bounds(&before_fragments[prefix..before_end])
        .or_else(|| approximate_focus_bounds(before, after))
        .or(Some(before.bounds));
    let after_focus = fragment_bounds(&after_fragments[prefix..after_end])
        .or_else(|| approximate_focus_bounds(after, before))
        .or(Some(after.bounds));
    let before_focus = if before.fragments.len() <= 1 || before_focus == Some(before.bounds) {
        approximate_focus_bounds(before, after).or(before_focus)
    } else {
        before_focus
    };
    let after_focus = if after.fragments.len() <= 1 || after_focus == Some(after.bounds) {
        approximate_focus_bounds(after, before).or(after_focus)
    } else {
        after_focus
    };
    (before_focus, after_focus)
}

fn effective_fragments(run: &TextRun) -> Vec<TextFragment> {
    if run.fragments.is_empty() {
        vec![TextFragment::new(run.text.clone(), run.bounds)]
    } else {
        run.fragments.clone()
    }
}

fn fragment_bounds(fragments: &[TextFragment]) -> Option<SemanticBounds> {
    fragments
        .iter()
        .map(|fragment| fragment.bounds)
        .reduce(union_bounds)
}

fn approximate_focus_bounds(run: &TextRun, other: &TextRun) -> Option<SemanticBounds> {
    let run_tokens = diff_tokens(&run.text);
    let other_tokens = diff_tokens(&other.text);
    if run_tokens.is_empty() || other_tokens.is_empty() {
        return Some(run.bounds);
    }

    let prefix = run_tokens
        .iter()
        .zip(other_tokens.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = run_tokens
        .iter()
        .rev()
        .zip(other_tokens.iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
        .min(run_tokens.len().saturating_sub(prefix))
        .min(other_tokens.len().saturating_sub(prefix));
    let changed_tokens = run_tokens.len().saturating_sub(prefix + suffix);
    let token_count = run_tokens.len().max(1) as f32;
    let start = run.bounds.x + run.bounds.width * prefix as f32 / token_count;
    let width = if changed_tokens == 0 {
        (run.bounds.height * 0.7).min(run.bounds.width.max(1.0))
    } else {
        (run.bounds.width * changed_tokens as f32 / token_count).max(run.bounds.height * 0.7)
    };
    Some(SemanticBounds::new(
        start,
        run.bounds.y,
        width.min((run.bounds.x + run.bounds.width - start).max(0.0)),
        run.bounds.height,
    ))
}

fn join_line_text(left: &str, right: &str) -> String {
    if left.is_empty() {
        return right.to_owned();
    }
    if right.is_empty()
        || right.starts_with(['.', ',', ';', ':', '!', '?', '%', ')', ']', '}'])
        || left.ends_with(['(', '[', '{'])
    {
        format!("{left}{right}")
    } else {
        format!("{left} {right}")
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SemanticChangeKind {
    Added,
    Removed,
    Modified,
    Moved,
    Reflowed,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SemanticTextBlockKind {
    #[default]
    Paragraph,
    ListItem,
    TableRow,
}

/// Conservative document-level role for a semantic text block.
///
/// `Header` and `Footer` are assigned only when the same edge-positioned text
/// recurs on at least two pages. A single-page heading remains `Body`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SemanticTextBlockRole {
    Body,
    Header,
    Footer,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemanticTextChange {
    pub id: String,
    pub kind: SemanticChangeKind,
    pub before_text: Option<String>,
    pub after_text: Option<String>,
    pub before_bounds: Option<SemanticBounds>,
    pub after_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_focus_bounds: Option<SemanticBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_focus_bounds: Option<SemanticBounds>,
}

/// A grouped, side-aware semantic text change.
///
/// The legacy `changes` field remains a positioned-run view. `blocks` is the
/// review-oriented view: adjacent changed lines are grouped, additions and
/// removals have anchors only on their owning side, and `text_diff` is scoped
/// to that block rather than the whole page.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemanticTextBlockDiff {
    pub id: String,
    pub kind: SemanticChangeKind,
    pub structure: SemanticTextBlockKind,
    pub confidence: f32,
    pub before_text: Option<String>,
    pub after_text: Option<String>,
    pub before_bounds: Option<SemanticBounds>,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemanticPageDiff {
    pub equal: bool,
    pub before_char_count: usize,
    pub after_char_count: usize,
    pub changes: Vec<SemanticTextChange>,
    pub blocks: Vec<SemanticTextBlockDiff>,
    pub changes_truncated: bool,
    pub before_extraction: TextExtractionSummary,
    pub after_extraction: TextExtractionSummary,
    pub quality: TextExtractionQuality,
    pub text_diff: TextDiff,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextDiff {
    pub changed_lines: usize,
    pub truncated: bool,
    pub hunks: Vec<TextDiffHunk>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextDiffHunk {
    pub before_start: usize,
    pub after_start: usize,
    pub lines: Vec<TextDiffLine>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextDiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextDiffLine {
    pub kind: TextDiffLineKind,
    pub before_line: Option<usize>,
    pub after_line: Option<usize>,
    pub text: String,
    pub spans: Vec<TextDiffSpan>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextDiffSpanKind {
    Equal,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextDiffSpan {
    pub kind: TextDiffSpanKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextDiffOptions {
    pub context_lines: usize,
}

impl Default for TextDiffOptions {
    fn default() -> Self {
        Self {
            context_lines: DEFAULT_TEXT_DIFF_CONTEXT_LINES,
        }
    }
}

pub fn compare_runs(before: &[TextRun], after: &[TextRun]) -> SemanticPageDiff {
    compare_runs_with_extraction(
        before,
        after,
        TextExtractionSummary::from_runs(before, 0),
        TextExtractionSummary::from_runs(after, 0),
    )
}

pub fn compare_runs_with_extraction(
    before: &[TextRun],
    after: &[TextRun],
    before_extraction: TextExtractionSummary,
    after_extraction: TextExtractionSummary,
) -> SemanticPageDiff {
    compare_runs_with_extraction_and_options(
        before,
        after,
        before_extraction,
        after_extraction,
        TextDiffOptions::default(),
    )
}

pub fn compare_runs_with_extraction_and_options(
    before: &[TextRun],
    after: &[TextRun],
    before_extraction: TextExtractionSummary,
    after_extraction: TextExtractionSummary,
    text_diff_options: TextDiffOptions,
) -> SemanticPageDiff {
    if before.len().saturating_mul(after.len()) > MAX_SEMANTIC_MATCH_MATRIX_CELLS {
        return compare_runs_bounded(
            before,
            after,
            before_extraction,
            after_extraction,
            text_diff_options,
        );
    }

    if is_text_reflow(before, after) {
        let change = reflowed_text_change(before, after);
        let blocks = build_semantic_text_blocks(before, after);
        return SemanticPageDiff {
            equal: false,
            before_char_count: before_extraction.char_count,
            after_char_count: after_extraction.char_count,
            changes: vec![change],
            blocks,
            changes_truncated: false,
            quality: extraction_quality(&before_extraction, &after_extraction),
            before_extraction,
            after_extraction,
            text_diff: empty_text_diff(),
        };
    }

    let mut before_matched = vec![false; before.len()];
    let mut after_matched = vec![false; after.len()];
    let mut changes = Vec::new();

    for (before_index, before_run) in before.iter().enumerate() {
        let candidate = after
            .iter()
            .enumerate()
            .filter(|(after_index, after_run)| {
                !after_matched[*after_index] && after_run.text == before_run.text
            })
            .min_by(|(_, left), (_, right)| {
                position_distance(before_run.bounds, left.bounds)
                    .total_cmp(&position_distance(before_run.bounds, right.bounds))
            })
            .map(|(after_index, _)| after_index);

        if let Some(after_index) = candidate {
            before_matched[before_index] = true;
            after_matched[after_index] = true;
            let after_run = &after[after_index];
            if position_distance(before_run.bounds, after_run.bounds) > POSITION_TOLERANCE {
                changes.push(SemanticTextChange {
                    id: format!("text-{}", changes.len() + 1),
                    kind: SemanticChangeKind::Moved,
                    before_text: Some(before_run.text.clone()),
                    after_text: Some(after_run.text.clone()),
                    before_bounds: Some(before_run.bounds),
                    after_bounds: Some(after_run.bounds),
                    before_focus_bounds: Some(before_run.bounds),
                    after_focus_bounds: Some(after_run.bounds),
                });
            }
        }
    }

    for (before_index, before_run) in before.iter().enumerate() {
        if before_matched[before_index] {
            continue;
        }
        let candidate = after
            .iter()
            .enumerate()
            .filter(|(after_index, after_run)| {
                !after_matched[*after_index]
                    && positional_match(before_run.bounds, after_run.bounds)
            })
            .min_by(|(_, left), (_, right)| {
                text_similarity(&before_run.text, &right.text)
                    .total_cmp(&text_similarity(&before_run.text, &left.text))
                    .then_with(|| {
                        position_distance(before_run.bounds, left.bounds)
                            .total_cmp(&position_distance(before_run.bounds, right.bounds))
                    })
            })
            .map(|(after_index, _)| after_index);

        if let Some(after_index) = candidate {
            before_matched[before_index] = true;
            after_matched[after_index] = true;
            let after_run = &after[after_index];
            changes.push(matched_text_change(
                format!("text-{}", changes.len() + 1),
                before_run,
                after_run,
            ));
        }
    }

    for (before_index, before_run) in before.iter().enumerate() {
        if !before_matched[before_index] {
            changes.push(SemanticTextChange {
                id: format!("text-{}", changes.len() + 1),
                kind: SemanticChangeKind::Removed,
                before_text: Some(before_run.text.clone()),
                after_text: None,
                before_bounds: Some(before_run.bounds),
                after_bounds: None,
                before_focus_bounds: Some(before_run.bounds),
                after_focus_bounds: None,
            });
        }
    }
    for (after_index, after_run) in after.iter().enumerate() {
        if !after_matched[after_index] {
            changes.push(SemanticTextChange {
                id: format!("text-{}", changes.len() + 1),
                kind: SemanticChangeKind::Added,
                before_text: None,
                after_text: Some(after_run.text.clone()),
                before_bounds: None,
                after_bounds: Some(after_run.bounds),
                before_focus_bounds: None,
                after_focus_bounds: Some(after_run.bounds),
            });
        }
    }

    let text_diff = build_text_diff(before, after, text_diff_options.context_lines);
    let blocks = build_semantic_text_blocks(before, after);
    SemanticPageDiff {
        equal: changes.is_empty(),
        before_char_count: before_extraction.char_count,
        after_char_count: after_extraction.char_count,
        changes,
        blocks,
        changes_truncated: false,
        quality: extraction_quality(&before_extraction, &after_extraction),
        before_extraction,
        after_extraction,
        text_diff,
    }
}

fn compare_runs_bounded(
    before: &[TextRun],
    after: &[TextRun],
    before_extraction: TextExtractionSummary,
    after_extraction: TextExtractionSummary,
    text_diff_options: TextDiffOptions,
) -> SemanticPageDiff {
    let mut changes = Vec::new();
    let mut changes_truncated = false;
    let mut has_difference = before.len() != after.len();

    for (before_run, after_run) in before.iter().zip(after.iter()) {
        let change = if before_run.text != after_run.text {
            has_difference = true;
            Some(matched_text_change(String::new(), before_run, after_run))
        } else if position_distance(before_run.bounds, after_run.bounds) > POSITION_TOLERANCE {
            has_difference = true;
            Some(SemanticTextChange {
                id: String::new(),
                kind: SemanticChangeKind::Moved,
                before_text: Some(before_run.text.clone()),
                after_text: Some(after_run.text.clone()),
                before_bounds: Some(before_run.bounds),
                after_bounds: Some(after_run.bounds),
                before_focus_bounds: Some(before_run.bounds),
                after_focus_bounds: Some(after_run.bounds),
            })
        } else {
            None
        };
        if let Some(change) = change {
            push_bounded_change(&mut changes, &mut changes_truncated, change);
        }
    }

    for before_run in before.iter().skip(after.len()) {
        has_difference = true;
        push_bounded_change(
            &mut changes,
            &mut changes_truncated,
            SemanticTextChange {
                id: String::new(),
                kind: SemanticChangeKind::Removed,
                before_text: Some(before_run.text.clone()),
                after_text: None,
                before_bounds: Some(before_run.bounds),
                after_bounds: None,
                before_focus_bounds: Some(before_run.bounds),
                after_focus_bounds: None,
            },
        );
    }
    for after_run in after.iter().skip(before.len()) {
        has_difference = true;
        push_bounded_change(
            &mut changes,
            &mut changes_truncated,
            SemanticTextChange {
                id: String::new(),
                kind: SemanticChangeKind::Added,
                before_text: None,
                after_text: Some(after_run.text.clone()),
                before_bounds: None,
                after_bounds: Some(after_run.bounds),
                before_focus_bounds: None,
                after_focus_bounds: Some(after_run.bounds),
            },
        );
    }

    let text_diff = build_text_diff(before, after, text_diff_options.context_lines);
    let blocks = build_semantic_text_blocks(before, after);
    SemanticPageDiff {
        equal: !has_difference,
        before_char_count: before_extraction.char_count,
        after_char_count: after_extraction.char_count,
        changes,
        blocks,
        changes_truncated,
        quality: extraction_quality(&before_extraction, &after_extraction),
        before_extraction,
        after_extraction,
        text_diff,
    }
}

fn push_bounded_change(
    changes: &mut Vec<SemanticTextChange>,
    changes_truncated: &mut bool,
    mut change: SemanticTextChange,
) {
    if changes.len() >= MAX_SEMANTIC_CHANGES {
        *changes_truncated = true;
        return;
    }
    change.id = format!("text-{}", changes.len() + 1);
    changes.push(change);
}

fn matched_text_change(id: String, before: &TextRun, after: &TextRun) -> SemanticTextChange {
    let kind = matched_text_kind(&before.text, &after.text);
    let (before_focus_bounds, after_focus_bounds) = changed_focus_bounds(before, after);
    let (before_text, after_text) = match kind {
        SemanticChangeKind::Added => (
            None,
            Some(changed_span_text(
                &before.text,
                &after.text,
                TextDiffSpanKind::Added,
            )),
        ),
        SemanticChangeKind::Removed => (
            Some(changed_span_text(
                &before.text,
                &after.text,
                TextDiffSpanKind::Removed,
            )),
            None,
        ),
        SemanticChangeKind::Modified | SemanticChangeKind::Moved | SemanticChangeKind::Reflowed => {
            (Some(before.text.clone()), Some(after.text.clone()))
        }
    };

    SemanticTextChange {
        id,
        kind,
        before_text,
        after_text,
        before_bounds: (!matches!(kind, SemanticChangeKind::Added)).then_some(before.bounds),
        after_bounds: (!matches!(kind, SemanticChangeKind::Removed)).then_some(after.bounds),
        before_focus_bounds: if matches!(kind, SemanticChangeKind::Added) {
            None
        } else {
            before_focus_bounds
        },
        after_focus_bounds: if matches!(kind, SemanticChangeKind::Removed) {
            None
        } else {
            after_focus_bounds
        },
    }
}

fn is_text_reflow(before: &[TextRun], after: &[TextRun]) -> bool {
    let before_tokens = flow_tokens(before);
    if before_tokens != flow_tokens(after) {
        return false;
    }
    line_token_boundaries(before) != line_token_boundaries(after)
}

fn reflowed_text_change(before: &[TextRun], after: &[TextRun]) -> SemanticTextChange {
    SemanticTextChange {
        id: "text-1".to_owned(),
        kind: SemanticChangeKind::Reflowed,
        before_text: Some(flow_text(before)),
        after_text: Some(flow_text(after)),
        before_bounds: runs_bounds(before),
        after_bounds: runs_bounds(after),
        before_focus_bounds: None,
        after_focus_bounds: None,
    }
}

fn runs_bounds(runs: &[TextRun]) -> Option<SemanticBounds> {
    runs.iter().map(|run| run.bounds).reduce(union_bounds)
}

fn flow_tokens(runs: &[TextRun]) -> Vec<String> {
    runs.iter().flat_map(|run| diff_tokens(&run.text)).collect()
}

fn flow_text(runs: &[TextRun]) -> String {
    runs.iter()
        .fold(String::new(), |text, run| join_line_text(&text, &run.text))
}

fn line_token_boundaries(runs: &[TextRun]) -> Vec<Vec<String>> {
    runs.iter().map(|run| diff_tokens(&run.text)).collect()
}

fn matched_text_kind(before: &str, after: &str) -> SemanticChangeKind {
    let before_tokens = diff_tokens(before);
    let after_tokens = diff_tokens(after);
    if before_tokens.len() < after_tokens.len()
        && is_token_subsequence(&before_tokens, &after_tokens)
    {
        SemanticChangeKind::Added
    } else if after_tokens.len() < before_tokens.len()
        && is_token_subsequence(&after_tokens, &before_tokens)
    {
        SemanticChangeKind::Removed
    } else {
        SemanticChangeKind::Modified
    }
}

fn is_token_subsequence(source: &[String], target: &[String]) -> bool {
    let mut source_index = 0;
    for token in target {
        if source.get(source_index) == Some(token) {
            source_index += 1;
        }
    }
    source_index == source.len()
}

fn changed_span_text(before: &str, after: &str, kind: TextDiffSpanKind) -> String {
    let (before_spans, after_spans) = inline_word_diff(before, after);
    let spans = match kind {
        TextDiffSpanKind::Added => after_spans,
        TextDiffSpanKind::Removed => before_spans,
        TextDiffSpanKind::Equal => Vec::new(),
    };
    spans
        .into_iter()
        .filter(|span| span.kind == kind)
        .map(|span| span.text)
        .fold(String::new(), |text, next| join_line_text(&text, &next))
        .trim()
        .to_owned()
}

fn extraction_quality(
    before: &TextExtractionSummary,
    after: &TextExtractionSummary,
) -> TextExtractionQuality {
    if before.status == TextExtractionStatus::Suspect
        || after.status == TextExtractionStatus::Suspect
    {
        TextExtractionQuality::Suspect
    } else if before.status == TextExtractionStatus::Empty
        && after.status == TextExtractionStatus::Empty
    {
        TextExtractionQuality::Empty
    } else if before.status == TextExtractionStatus::Empty
        || after.status == TextExtractionStatus::Empty
    {
        TextExtractionQuality::Partial
    } else {
        TextExtractionQuality::Text
    }
}

const MAX_TEXT_DIFF_MATRIX_CELLS: usize = 4_000_000;
const MAX_STRUCTURAL_BLOCK_ALIGNMENT_CELLS: usize = 1_000_000;
const STRUCTURAL_BLOCK_MATCH_THRESHOLD: f32 = 0.55;

fn empty_text_diff() -> TextDiff {
    TextDiff {
        changed_lines: 0,
        truncated: false,
        hunks: Vec::new(),
    }
}

#[derive(Debug, Clone)]
struct StructuralTextBlock {
    kind: SemanticTextBlockKind,
    lines: Vec<TextRun>,
    text: String,
    bounds: Option<SemanticBounds>,
}

#[derive(Debug, Clone, Copy)]
struct BlockSpan {
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Copy)]
struct StructuralBlockPair {
    before: Option<BlockSpan>,
    after: Option<BlockSpan>,
    confidence: f32,
}

fn build_semantic_text_blocks(before: &[TextRun], after: &[TextRun]) -> Vec<SemanticTextBlockDiff> {
    let before_blocks = segment_structural_text_blocks(before);
    let after_blocks = segment_structural_text_blocks(after);
    let pairs = align_structural_text_blocks(&before_blocks, &after_blocks);
    let mut blocks = pairs
        .into_iter()
        .filter_map(|pair| semantic_block_from_structural_pair(&before_blocks, &after_blocks, pair))
        .collect::<Vec<_>>();
    for (index, block) in blocks.iter_mut().enumerate() {
        block.id = format!("block-{}", index + 1);
    }
    blocks
}

fn segment_structural_text_blocks(runs: &[TextRun]) -> Vec<StructuralTextBlock> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for run in runs.iter().cloned() {
        if current
            .last()
            .is_some_and(|previous| can_join_structural_lines(previous, &run, &current))
        {
            current.push(run);
        } else {
            if !current.is_empty() {
                blocks.push(finish_structural_text_block(std::mem::take(&mut current)));
            }
            current.push(run);
        }
    }
    if !current.is_empty() {
        blocks.push(finish_structural_text_block(current));
    }
    blocks
}

fn can_join_structural_lines(previous: &TextRun, next: &TextRun, current: &[TextRun]) -> bool {
    if is_table_row_run(previous) || is_table_row_run(next) || is_list_item_run(next) {
        return false;
    }
    if current.iter().any(is_table_row_run) {
        return false;
    }
    let vertical_gap = (previous.bounds.center_y() - next.bounds.center_y()).abs();
    let max_height = previous.bounds.height.max(next.bounds.height).max(1.0);
    if vertical_gap > (max_height * 2.25).max(24.0) {
        return false;
    }
    if previous
        .text
        .trim_end()
        .chars()
        .last()
        .is_some_and(|character| matches!(character, '.' | '!' | '?' | ':' | ';'))
        && vertical_gap > (max_height * 1.35).max(16.0)
    {
        return false;
    }
    let horizontal_overlap = rectangle_intersection(
        SemanticBounds::new(previous.bounds.x, 0.0, previous.bounds.width, 1.0),
        SemanticBounds::new(next.bounds.x, 0.0, next.bounds.width, 1.0),
    );
    let indent_delta = (previous.bounds.x - next.bounds.x).abs();
    horizontal_overlap > 0.0 || indent_delta <= (max_height * 2.5).max(18.0)
}

fn finish_structural_text_block(lines: Vec<TextRun>) -> StructuralTextBlock {
    let kind = if lines.iter().any(is_table_row_run) {
        SemanticTextBlockKind::TableRow
    } else if lines.iter().any(is_list_item_run) || is_list_marker(&flow_text(&lines)) {
        SemanticTextBlockKind::ListItem
    } else {
        SemanticTextBlockKind::Paragraph
    };
    let text = flow_text(&lines);
    let bounds = runs_bounds(&lines);
    StructuralTextBlock {
        kind,
        lines,
        text,
        bounds,
    }
}

fn is_list_marker(text: &str) -> bool {
    let mut chars = text.trim_start().chars().peekable();
    match chars.next() {
        Some('-' | '*' | '•' | '–' | '—') => chars
            .next()
            .map_or(true, |character| character.is_whitespace()),
        Some(first) if first.is_ascii_digit() => {
            while chars
                .peek()
                .is_some_and(|character| character.is_ascii_digit())
            {
                chars.next();
            }
            matches!(chars.next(), Some('.') | Some(')'))
                && chars
                    .next()
                    .is_some_and(|character| character.is_whitespace())
        }
        Some(first) if first.is_ascii_alphabetic() => {
            matches!(chars.next(), Some('.') | Some(')'))
                && chars
                    .next()
                    .is_some_and(|character| character.is_whitespace())
        }
        _ => false,
    }
}

fn is_list_item_run(run: &TextRun) -> bool {
    if is_list_marker(&run.text) {
        return true;
    }
    let fragments = effective_fragments(run);
    if fragments.len() < 2 {
        return false;
    }
    let candidate = format!("{} {}", fragments[0].text, fragments[1].text);
    is_list_marker(&candidate)
}

fn is_table_row_run(run: &TextRun) -> bool {
    if run.text.contains('|') || run.text.contains('\t') {
        return true;
    }
    let fragments = effective_fragments(run);
    fragments
        .windows(2)
        .filter(|pair| {
            let gap = pair[1].bounds.x - (pair[0].bounds.x + pair[0].bounds.width);
            gap >= MIN_COLUMN_GAP
        })
        .count()
        >= 2
}

fn align_structural_text_blocks(
    before: &[StructuralTextBlock],
    after: &[StructuralTextBlock],
) -> Vec<StructuralBlockPair> {
    let anchors = exact_structural_block_anchors(before, after);
    let mut pairs = Vec::new();
    let (mut before_cursor, mut after_cursor) = (0, 0);
    for (before_anchor, after_anchor) in anchors {
        align_structural_gap(
            before,
            after,
            BlockSpan {
                start: before_cursor,
                end: before_anchor,
            },
            BlockSpan {
                start: after_cursor,
                end: after_anchor,
            },
            &mut pairs,
        );
        pairs.push(StructuralBlockPair {
            before: Some(BlockSpan {
                start: before_anchor,
                end: before_anchor + 1,
            }),
            after: Some(BlockSpan {
                start: after_anchor,
                end: after_anchor + 1,
            }),
            confidence: 1.0,
        });
        before_cursor = before_anchor + 1;
        after_cursor = after_anchor + 1;
    }
    align_structural_gap(
        before,
        after,
        BlockSpan {
            start: before_cursor,
            end: before.len(),
        },
        BlockSpan {
            start: after_cursor,
            end: after.len(),
        },
        &mut pairs,
    );
    pairs
}

fn exact_structural_block_anchors(
    before: &[StructuralTextBlock],
    after: &[StructuralTextBlock],
) -> Vec<(usize, usize)> {
    let cells = before
        .len()
        .saturating_add(1)
        .saturating_mul(after.len().saturating_add(1));
    if cells > MAX_STRUCTURAL_BLOCK_ALIGNMENT_CELLS {
        return Vec::new();
    }
    let mut lcs = vec![vec![0; after.len() + 1]; before.len() + 1];
    for before_index in (0..before.len()).rev() {
        for after_index in (0..after.len()).rev() {
            lcs[before_index][after_index] = if before[before_index].text == after[after_index].text
            {
                lcs[before_index + 1][after_index + 1] + 1
            } else {
                lcs[before_index + 1][after_index].max(lcs[before_index][after_index + 1])
            };
        }
    }
    let mut anchors = Vec::new();
    let (mut before_index, mut after_index) = (0, 0);
    while before_index < before.len() && after_index < after.len() {
        if before[before_index].text == after[after_index].text {
            anchors.push((before_index, after_index));
            before_index += 1;
            after_index += 1;
        } else if lcs[before_index + 1][after_index] >= lcs[before_index][after_index + 1] {
            before_index += 1;
        } else {
            after_index += 1;
        }
    }
    anchors
}

fn align_structural_gap(
    before: &[StructuralTextBlock],
    after: &[StructuralTextBlock],
    before_span: BlockSpan,
    after_span: BlockSpan,
    pairs: &mut Vec<StructuralBlockPair>,
) {
    let (mut before_index, mut after_index) = (before_span.start, after_span.start);
    while before_index < before_span.end || after_index < after_span.end {
        let remaining_before = before_span.end.saturating_sub(before_index);
        let remaining_after = after_span.end.saturating_sub(after_index);
        if remaining_before == 0 {
            pairs.push(StructuralBlockPair {
                before: None,
                after: Some(BlockSpan {
                    start: after_index,
                    end: after_span.end,
                }),
                confidence: 1.0,
            });
            break;
        }
        if remaining_after == 0 {
            pairs.push(StructuralBlockPair {
                before: Some(BlockSpan {
                    start: before_index,
                    end: before_span.end,
                }),
                after: None,
                confidence: 1.0,
            });
            break;
        }
        if let Some((before_count, after_count, confidence)) = best_structural_candidate(
            before,
            after,
            before_index,
            after_index,
            remaining_before,
            remaining_after,
        ) {
            pairs.push(StructuralBlockPair {
                before: Some(BlockSpan {
                    start: before_index,
                    end: before_index + before_count,
                }),
                after: Some(BlockSpan {
                    start: after_index,
                    end: after_index + after_count,
                }),
                confidence,
            });
            before_index += before_count;
            after_index += after_count;
        } else {
            pairs.push(StructuralBlockPair {
                before: Some(BlockSpan {
                    start: before_index,
                    end: before_index + 1,
                }),
                after: None,
                confidence: 1.0,
            });
            before_index += 1;
        }
    }
}

fn best_structural_candidate(
    before: &[StructuralTextBlock],
    after: &[StructuralTextBlock],
    before_start: usize,
    after_start: usize,
    remaining_before: usize,
    remaining_after: usize,
) -> Option<(usize, usize, f32)> {
    let mut best: Option<(usize, usize, f32)> = None;
    for before_count in 1..=remaining_before.min(2) {
        for after_count in 1..=remaining_after.min(2) {
            let before_slice = &before[before_start..before_start + before_count];
            let after_slice = &after[after_start..after_start + after_count];
            let before_text = structural_span_text(before_slice);
            let after_text = structural_span_text(after_slice);
            let similarity = text_similarity(&before_text, &after_text);
            let geometry = structural_geometry_score(before_slice, after_slice);
            if similarity < STRUCTURAL_BLOCK_MATCH_THRESHOLD
                || (geometry == 0.0 && similarity < 0.78)
            {
                continue;
            }
            let confidence = (similarity * 0.75 + geometry * 0.25).min(1.0);
            let candidate = (before_count, after_count, confidence);
            if best.map_or(true, |current| {
                confidence > current.2
                    || (confidence == current.2
                        && before_count + after_count < current.0 + current.1)
            }) {
                best = Some(candidate);
            }
        }
    }
    best
}

fn structural_span_text(blocks: &[StructuralTextBlock]) -> String {
    blocks.iter().fold(String::new(), |text, block| {
        join_line_text(&text, &block.text)
    })
}

fn structural_geometry_score(before: &[StructuralTextBlock], after: &[StructuralTextBlock]) -> f32 {
    let Some(before_bounds) = structural_span_bounds(before) else {
        return 0.0;
    };
    let Some(after_bounds) = structural_span_bounds(after) else {
        return 0.0;
    };
    if positional_match(before_bounds, after_bounds) {
        return 1.0;
    }
    let distance = position_distance(before_bounds, after_bounds);
    let scale = before_bounds
        .width
        .max(after_bounds.width)
        .max(before_bounds.height)
        .max(after_bounds.height)
        .max(1.0);
    if distance <= scale * 3.0 {
        0.5
    } else {
        0.0
    }
}

fn structural_span_bounds(blocks: &[StructuralTextBlock]) -> Option<SemanticBounds> {
    blocks
        .iter()
        .filter_map(|block| block.bounds)
        .reduce(union_bounds)
}

fn semantic_block_from_structural_pair(
    before_blocks: &[StructuralTextBlock],
    after_blocks: &[StructuralTextBlock],
    pair: StructuralBlockPair,
) -> Option<SemanticTextBlockDiff> {
    let before_runs = pair
        .before
        .map(|span| flatten_structural_blocks(&before_blocks[span.start..span.end]))
        .unwrap_or_default();
    let after_runs = pair
        .after
        .map(|span| flatten_structural_blocks(&after_blocks[span.start..span.end]))
        .unwrap_or_default();
    if before_runs.is_empty() && after_runs.is_empty() {
        return None;
    }
    let before_text_full = flow_text(&before_runs);
    let after_text_full = flow_text(&after_runs);
    let before_kind = pair
        .before
        .and_then(|span| structural_span_kind(&before_blocks[span.start..span.end]));
    let after_kind = pair
        .after
        .and_then(|span| structural_span_kind(&after_blocks[span.start..span.end]));
    let text_structure = if before_text_full.contains('|') || after_text_full.contains('|') {
        Some(SemanticTextBlockKind::TableRow)
    } else if is_list_marker(&before_text_full) || is_list_marker(&after_text_full) {
        Some(SemanticTextBlockKind::ListItem)
    } else {
        None
    };
    let structure = if let Some(text_structure) = text_structure {
        text_structure
    } else if before_kind == after_kind {
        before_kind.or(after_kind).unwrap_or_default()
    } else {
        SemanticTextBlockKind::Paragraph
    };
    let before_bounds = runs_bounds(&before_runs);
    let after_bounds = runs_bounds(&after_runs);
    let same_geometry = before_bounds
        .zip(after_bounds)
        .is_some_and(|(before, after)| position_distance(before, after) <= POSITION_TOLERANCE);
    let kind = match (before_runs.is_empty(), after_runs.is_empty()) {
        (true, false) => SemanticChangeKind::Added,
        (false, true) => SemanticChangeKind::Removed,
        (false, false) if is_text_reflow(&before_runs, &after_runs) => SemanticChangeKind::Reflowed,
        (false, false)
            if before_text_full == after_text_full
                && same_geometry
                && before_kind == after_kind =>
        {
            return None;
        }
        (false, false) if before_text_full == after_text_full => SemanticChangeKind::Moved,
        (false, false) => matched_text_kind(&before_text_full, &after_text_full),
        (true, true) => return None,
    };
    let (before_focus_bounds, after_focus_bounds) =
        structural_focus_bounds(kind, &before_runs, &after_runs, before_bounds, after_bounds);
    let (before_text, after_text) = match kind {
        SemanticChangeKind::Added => (
            None,
            Some(changed_span_text(
                &before_text_full,
                &after_text_full,
                TextDiffSpanKind::Added,
            )),
        ),
        SemanticChangeKind::Removed => (
            Some(changed_span_text(
                &before_text_full,
                &after_text_full,
                TextDiffSpanKind::Removed,
            )),
            None,
        ),
        SemanticChangeKind::Modified | SemanticChangeKind::Moved | SemanticChangeKind::Reflowed => {
            (Some(before_text_full), Some(after_text_full))
        }
    };
    let before_role = before_text.as_ref().map(|_| SemanticTextBlockRole::Body);
    let after_role = after_text.as_ref().map(|_| SemanticTextBlockRole::Body);
    let text_diff = if matches!(
        kind,
        SemanticChangeKind::Moved | SemanticChangeKind::Reflowed
    ) {
        empty_text_diff()
    } else {
        build_text_diff(&before_runs, &after_runs, 0)
    };
    Some(SemanticTextBlockDiff {
        id: String::new(),
        kind,
        structure,
        confidence: pair.confidence,
        before_text,
        after_text,
        before_bounds: if matches!(kind, SemanticChangeKind::Added) {
            None
        } else {
            before_bounds
        },
        after_bounds: if matches!(kind, SemanticChangeKind::Removed) {
            None
        } else {
            after_bounds
        },
        before_focus_bounds,
        after_focus_bounds,
        before_role,
        after_role,
        text_diff,
    })
}

fn flatten_structural_blocks(blocks: &[StructuralTextBlock]) -> Vec<TextRun> {
    blocks
        .iter()
        .flat_map(|block| block.lines.iter().cloned())
        .collect()
}

fn structural_span_kind(blocks: &[StructuralTextBlock]) -> Option<SemanticTextBlockKind> {
    let first = blocks.first()?.kind;
    if blocks
        .iter()
        .any(|block| block.kind == SemanticTextBlockKind::TableRow || block.text.contains('|'))
    {
        Some(SemanticTextBlockKind::TableRow)
    } else if blocks
        .iter()
        .any(|block| block.kind == SemanticTextBlockKind::ListItem || is_list_marker(&block.text))
    {
        Some(SemanticTextBlockKind::ListItem)
    } else if blocks.iter().all(|block| block.kind == first) {
        Some(first)
    } else {
        None
    }
}

fn structural_focus_bounds(
    kind: SemanticChangeKind,
    before: &[TextRun],
    after: &[TextRun],
    before_bounds: Option<SemanticBounds>,
    after_bounds: Option<SemanticBounds>,
) -> (Option<SemanticBounds>, Option<SemanticBounds>) {
    if before.len() == 1 && after.len() == 1 {
        let (before_focus, after_focus) = changed_focus_bounds(&before[0], &after[0]);
        return (
            if matches!(kind, SemanticChangeKind::Added) {
                None
            } else {
                before_focus
            },
            if matches!(kind, SemanticChangeKind::Removed) {
                None
            } else {
                after_focus
            },
        );
    }
    (
        if matches!(kind, SemanticChangeKind::Added) {
            None
        } else {
            before_bounds
        },
        if matches!(kind, SemanticChangeKind::Removed) {
            None
        } else {
            after_bounds
        },
    )
}

fn build_text_diff(before: &[TextRun], after: &[TextRun], context_lines: usize) -> TextDiff {
    if before.is_empty() && after.is_empty() {
        return empty_text_diff();
    }

    if before
        .len()
        .saturating_add(1)
        .saturating_mul(after.len().saturating_add(1))
        > MAX_TEXT_DIFF_MATRIX_CELLS
    {
        return TextDiff {
            changed_lines: 0,
            truncated: true,
            hunks: Vec::new(),
        };
    }

    let lcs = longest_common_subsequence(before, after);
    if should_use_flow_text_diff(before, after, &lcs) {
        return build_flow_text_diff(before, after);
    }
    let mut lines = Vec::with_capacity(before.len() + after.len());
    let (mut before_index, mut after_index) = (0, 0);

    while before_index < before.len() || after_index < after.len() {
        if before_index < before.len()
            && after_index < after.len()
            && before[before_index].text == after[after_index].text
        {
            lines.push(TextDiffLine {
                kind: TextDiffLineKind::Context,
                before_line: Some(before_index + 1),
                after_line: Some(after_index + 1),
                text: before[before_index].text.clone(),
                spans: vec![TextDiffSpan {
                    kind: TextDiffSpanKind::Equal,
                    text: before[before_index].text.clone(),
                }],
            });
            before_index += 1;
            after_index += 1;
            continue;
        }

        if before_index < before.len()
            && (after_index == after.len()
                || lcs[before_index + 1][after_index] >= lcs[before_index][after_index + 1])
        {
            lines.push(TextDiffLine {
                kind: TextDiffLineKind::Removed,
                before_line: Some(before_index + 1),
                after_line: None,
                text: before[before_index].text.clone(),
                spans: Vec::new(),
            });
            before_index += 1;
        } else if after_index < after.len() {
            lines.push(TextDiffLine {
                kind: TextDiffLineKind::Added,
                before_line: None,
                after_line: Some(after_index + 1),
                text: after[after_index].text.clone(),
                spans: Vec::new(),
            });
            after_index += 1;
        }
    }

    add_inline_spans(&mut lines);
    let changed_lines = lines
        .iter()
        .filter(|line| line.kind != TextDiffLineKind::Context)
        .count();
    let hunks = build_hunks(&lines, context_lines);
    TextDiff {
        changed_lines,
        truncated: false,
        hunks,
    }
}

fn should_use_flow_text_diff(
    before: &[TextRun],
    after: &[TextRun],
    line_lcs: &[Vec<usize>],
) -> bool {
    if before.is_empty() || after.is_empty() {
        return false;
    }
    let before_tokens = flow_tokens(before);
    let after_tokens = flow_tokens(after);
    if before_tokens == after_tokens {
        return false;
    }
    let token_cells = before_tokens
        .len()
        .saturating_add(1)
        .saturating_mul(after_tokens.len().saturating_add(1));
    if token_cells > MAX_TEXT_DIFF_MATRIX_CELLS {
        return false;
    }
    let larger_token_count = before_tokens.len().max(after_tokens.len());
    if larger_token_count == 0 {
        return false;
    }
    let token_lcs = longest_common_words(&before_tokens, &after_tokens);
    let token_similarity = token_lcs[0][0] as f32 / larger_token_count as f32;
    let larger_line_count = before.len().max(after.len());
    let line_similarity = line_lcs[0][0] as f32 / larger_line_count as f32;
    token_similarity >= REFLOW_MIN_TOKEN_SIMILARITY && line_similarity < REFLOW_MAX_LINE_SIMILARITY
}

fn build_flow_text_diff(before: &[TextRun], after: &[TextRun]) -> TextDiff {
    let before_text = flow_text(before);
    let after_text = flow_text(after);
    let (before_spans, after_spans) = inline_word_diff(&before_text, &after_text);
    let mut lines = Vec::with_capacity(2);
    if !before_text.is_empty() {
        lines.push(TextDiffLine {
            kind: TextDiffLineKind::Removed,
            before_line: Some(1),
            after_line: None,
            text: before_text,
            spans: before_spans,
        });
    }
    if !after_text.is_empty() {
        lines.push(TextDiffLine {
            kind: TextDiffLineKind::Added,
            before_line: None,
            after_line: Some(1),
            text: after_text,
            spans: after_spans,
        });
    }
    TextDiff {
        changed_lines: lines.len(),
        truncated: false,
        hunks: vec![TextDiffHunk {
            before_start: 1,
            after_start: 1,
            lines,
        }],
    }
}

fn longest_common_subsequence(before: &[TextRun], after: &[TextRun]) -> Vec<Vec<usize>> {
    let mut lcs = vec![vec![0; after.len() + 1]; before.len() + 1];
    for before_index in (0..before.len()).rev() {
        for after_index in (0..after.len()).rev() {
            lcs[before_index][after_index] = if before[before_index].text == after[after_index].text
            {
                lcs[before_index + 1][after_index + 1] + 1
            } else {
                lcs[before_index + 1][after_index].max(lcs[before_index][after_index + 1])
            };
        }
    }
    lcs
}

fn add_inline_spans(lines: &mut [TextDiffLine]) {
    let mut index = 0;
    while index < lines.len() {
        if lines[index].kind == TextDiffLineKind::Context {
            lines[index].spans = vec![TextDiffSpan {
                kind: TextDiffSpanKind::Equal,
                text: lines[index].text.clone(),
            }];
            index += 1;
            continue;
        }

        let end = lines[index..]
            .iter()
            .position(|line| line.kind == TextDiffLineKind::Context)
            .map_or(lines.len(), |offset| index + offset);
        let removed = (index..end)
            .filter(|line_index| lines[*line_index].kind == TextDiffLineKind::Removed)
            .collect::<Vec<_>>();
        let added = (index..end)
            .filter(|line_index| lines[*line_index].kind == TextDiffLineKind::Added)
            .collect::<Vec<_>>();

        for (before_index, after_index) in removed.iter().zip(added.iter()) {
            let before_text = lines[*before_index].text.clone();
            let after_text = lines[*after_index].text.clone();
            let (before_spans, after_spans) = inline_word_diff(&before_text, &after_text);
            lines[*before_index].spans = before_spans;
            lines[*after_index].spans = after_spans;
        }

        for line in &mut lines[index..end] {
            if line.spans.is_empty() {
                line.spans = vec![TextDiffSpan {
                    kind: match line.kind {
                        TextDiffLineKind::Added => TextDiffSpanKind::Added,
                        TextDiffLineKind::Removed => TextDiffSpanKind::Removed,
                        TextDiffLineKind::Context => TextDiffSpanKind::Equal,
                    },
                    text: line.text.clone(),
                }];
            }
        }
        index = end;
    }
}

fn inline_word_diff(before: &str, after: &str) -> (Vec<TextDiffSpan>, Vec<TextDiffSpan>) {
    let before_words = diff_tokens(before);
    let after_words = diff_tokens(after);
    if before_words
        .len()
        .saturating_add(1)
        .saturating_mul(after_words.len().saturating_add(1))
        > MAX_TEXT_DIFF_MATRIX_CELLS
    {
        return (
            vec![TextDiffSpan {
                kind: TextDiffSpanKind::Removed,
                text: before.to_owned(),
            }],
            vec![TextDiffSpan {
                kind: TextDiffSpanKind::Added,
                text: after.to_owned(),
            }],
        );
    }

    let lcs = longest_common_words(&before_words, &after_words);
    let mut before_spans = Vec::new();
    let mut after_spans = Vec::new();
    let (mut before_index, mut after_index) = (0, 0);
    while before_index < before_words.len() || after_index < after_words.len() {
        if before_index < before_words.len()
            && after_index < after_words.len()
            && before_words[before_index] == after_words[after_index]
        {
            push_span(
                &mut before_spans,
                TextDiffSpanKind::Equal,
                &before_words[before_index],
            );
            push_span(
                &mut after_spans,
                TextDiffSpanKind::Equal,
                &after_words[after_index],
            );
            before_index += 1;
            after_index += 1;
        } else if before_index < before_words.len()
            && (after_index == after_words.len()
                || lcs[before_index + 1][after_index] >= lcs[before_index][after_index + 1])
        {
            push_span(
                &mut before_spans,
                TextDiffSpanKind::Removed,
                &before_words[before_index],
            );
            before_index += 1;
        } else {
            push_span(
                &mut after_spans,
                TextDiffSpanKind::Added,
                &after_words[after_index],
            );
            after_index += 1;
        }
    }
    (before_spans, after_spans)
}

fn diff_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() || character == '_' {
            word.push(character);
            continue;
        }
        if !word.is_empty() {
            tokens.push(std::mem::take(&mut word));
        }
        if !character.is_whitespace() {
            tokens.push(character.to_string());
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}

fn text_similarity(before: &str, after: &str) -> f32 {
    if before == after {
        return 1.0;
    }
    let before_tokens = diff_tokens(before);
    let after_tokens = diff_tokens(after);
    let larger = before_tokens.len().max(after_tokens.len());
    if larger == 0 {
        return 1.0;
    }
    let matrix_cells = before_tokens
        .len()
        .saturating_add(1)
        .saturating_mul(after_tokens.len().saturating_add(1));
    if matrix_cells > 4_096 {
        let prefix = before_tokens
            .iter()
            .zip(after_tokens.iter())
            .take_while(|(left, right)| left == right)
            .count();
        return prefix as f32 / larger as f32;
    }
    let lcs = longest_common_words(&before_tokens, &after_tokens);
    lcs[0][0] as f32 / larger as f32
}

fn longest_common_words(before: &[String], after: &[String]) -> Vec<Vec<usize>> {
    let mut lcs = vec![vec![0; after.len() + 1]; before.len() + 1];
    for before_index in (0..before.len()).rev() {
        for after_index in (0..after.len()).rev() {
            lcs[before_index][after_index] = if before[before_index] == after[after_index] {
                lcs[before_index + 1][after_index + 1] + 1
            } else {
                lcs[before_index + 1][after_index].max(lcs[before_index][after_index + 1])
            };
        }
    }
    lcs
}

fn push_span(spans: &mut Vec<TextDiffSpan>, kind: TextDiffSpanKind, text: &str) {
    if let Some(previous) = spans.last_mut().filter(|span| span.kind == kind) {
        if needs_token_space(&previous.text, text) {
            previous.text.push(' ');
        }
        previous.text.push_str(text);
    } else {
        spans.push(TextDiffSpan {
            kind,
            text: if spans
                .last()
                .is_some_and(|previous| needs_token_space(&previous.text, text))
            {
                format!(" {text}")
            } else {
                text.to_owned()
            },
        });
    }
}

fn needs_token_space(left: &str, right: &str) -> bool {
    let Some(right_first) = right.chars().next() else {
        return false;
    };
    if matches!(
        right_first,
        '.' | ',' | ';' | ':' | '!' | '?' | '%' | ')' | ']' | '}' | '\'' | '’'
    ) {
        return false;
    }
    !left
        .chars()
        .next_back()
        .is_some_and(|left_last| matches!(left_last, '(' | '[' | '{' | '\'' | '’'))
}

fn build_hunks(lines: &[TextDiffLine], context_lines: usize) -> Vec<TextDiffHunk> {
    let changed_indices = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| (line.kind != TextDiffLineKind::Context).then_some(index))
        .collect::<Vec<_>>();
    if changed_indices.is_empty() {
        return Vec::new();
    }

    let context_lines = context_lines.min(MAX_TEXT_DIFF_CONTEXT_LINES);
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for index in changed_indices {
        let range = (
            index.saturating_sub(context_lines),
            (index + context_lines + 1).min(lines.len()),
        );
        if let Some(previous) = ranges.last_mut() {
            if range.0 <= previous.1 {
                previous.1 = previous.1.max(range.1);
                continue;
            }
        }
        ranges.push(range);
    }

    ranges
        .into_iter()
        .map(|(start, end)| {
            let selected = lines[start..end].to_vec();
            TextDiffHunk {
                before_start: selected
                    .iter()
                    .find_map(|line| line.before_line)
                    .unwrap_or(1),
                after_start: selected
                    .iter()
                    .find_map(|line| line.after_line)
                    .unwrap_or(1),
                lines: selected,
            }
        })
        .collect()
}

fn position_distance(before: SemanticBounds, after: SemanticBounds) -> f32 {
    let dx = before.center_x() - after.center_x();
    let dy = before.center_y() - after.center_y();
    (dx * dx + dy * dy).sqrt()
}

fn positional_match(before: SemanticBounds, after: SemanticBounds) -> bool {
    let intersection = rectangle_intersection(before, after);
    if intersection <= 0.0 {
        return position_distance(before, after)
            <= before
                .width
                .max(after.width)
                .max(before.height)
                .max(after.height)
                * 1.5;
    }
    let union = before.width * before.height + after.width * after.height - intersection;
    union > 0.0 && intersection / union >= 0.12
}

fn rectangle_intersection(before: SemanticBounds, after: SemanticBounds) -> f32 {
    let width = (before.x + before.width).min(after.x + after.width) - before.x.max(after.x);
    let height = (before.y + before.height).min(after.y + after.height) - before.y.max(after.y);
    if width <= 0.0 || height <= 0.0 {
        0.0
    } else {
        width * height
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, x: f32, y: f32) -> TextRun {
        TextRun::new(text, SemanticBounds::new(x, y, 40.0, 12.0))
    }

    #[test]
    fn identical_runs_are_equal() {
        let result = compare_runs(&[run("Hello", 10.0, 20.0)], &[run("Hello", 10.0, 20.0)]);
        assert!(result.equal);
        assert!(result.changes.is_empty());
        assert!(result.blocks.is_empty());
        assert_eq!(result.quality, TextExtractionQuality::Text);
    }

    #[test]
    fn normalize_text_runs_reconstructs_a_reading_line() {
        let runs = [
            TextRun::new("Hello", SemanticBounds::new(10.0, 20.0, 24.0, 12.0)),
            TextRun::new("world", SemanticBounds::new(40.0, 20.5, 28.0, 12.0)),
            TextRun::new(".", SemanticBounds::new(69.0, 20.0, 4.0, 12.0)),
            TextRun::new("Next", SemanticBounds::new(10.0, 42.0, 24.0, 12.0)),
        ];

        let normalized = normalize_text_runs(&runs);

        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].text, "Hello world.");
        assert_eq!(normalized[1].text, "Next");
        assert_eq!(normalized[0].bounds.x, 10.0);
        assert_eq!(normalized[0].bounds.width, 63.0);
    }

    #[test]
    fn normalize_text_runs_reads_columns_top_to_bottom() {
        let runs = [
            TextRun::new("Left one", SemanticBounds::new(10.0, 20.0, 80.0, 12.0)),
            TextRun::new("Right one", SemanticBounds::new(220.0, 20.0, 80.0, 12.0)),
            TextRun::new("Left two", SemanticBounds::new(10.0, 40.0, 80.0, 12.0)),
            TextRun::new("Right two", SemanticBounds::new(220.0, 40.0, 80.0, 12.0)),
        ];

        let normalized = normalize_text_runs(&runs);

        assert_eq!(
            normalized
                .iter()
                .map(|run| run.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Left one", "Left two", "Right one", "Right two"]
        );
    }

    #[test]
    fn normalize_text_runs_can_force_row_major_order() {
        let runs = [
            TextRun::new("Left one", SemanticBounds::new(10.0, 20.0, 80.0, 12.0)),
            TextRun::new("Right one", SemanticBounds::new(220.0, 20.0, 80.0, 12.0)),
            TextRun::new("Left two", SemanticBounds::new(10.0, 40.0, 80.0, 12.0)),
            TextRun::new("Right two", SemanticBounds::new(220.0, 40.0, 80.0, 12.0)),
        ];

        let normalized = normalize_text_runs_with_reading_order(&runs, TextReadingOrder::Rows);

        assert_eq!(
            normalized
                .iter()
                .map(|run| run.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Left one", "Right one", "Left two", "Right two"]
        );
    }

    #[test]
    fn normalize_text_runs_can_force_column_major_order() {
        let runs = [
            TextRun::new("Left one", SemanticBounds::new(10.0, 20.0, 80.0, 12.0)),
            TextRun::new("Right one", SemanticBounds::new(220.0, 20.0, 80.0, 12.0)),
            TextRun::new("Left two", SemanticBounds::new(10.0, 40.0, 80.0, 12.0)),
            TextRun::new("Right two", SemanticBounds::new(220.0, 40.0, 80.0, 12.0)),
        ];

        let normalized = normalize_text_runs_with_reading_order(&runs, TextReadingOrder::Columns);

        assert_eq!(
            normalized
                .iter()
                .map(|run| run.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Left one", "Left two", "Right one", "Right two"]
        );
    }

    #[test]
    fn normalize_text_runs_keeps_a_full_width_heading_before_columns() {
        let runs = [
            TextRun::new(
                "Document heading",
                SemanticBounds::new(10.0, 10.0, 290.0, 12.0),
            ),
            TextRun::new("Left one", SemanticBounds::new(10.0, 30.0, 80.0, 12.0)),
            TextRun::new("Right one", SemanticBounds::new(220.0, 30.0, 80.0, 12.0)),
            TextRun::new("Left two", SemanticBounds::new(10.0, 50.0, 80.0, 12.0)),
            TextRun::new("Right two", SemanticBounds::new(220.0, 50.0, 80.0, 12.0)),
        ];

        let normalized = normalize_text_runs(&runs);

        assert_eq!(normalized[0].text, "Document heading");
        assert_eq!(normalized[1].text, "Left one");
        assert_eq!(normalized[2].text, "Left two");
        assert_eq!(normalized[3].text, "Right one");
        assert_eq!(normalized[4].text, "Right two");
    }

    #[test]
    fn extraction_quality_reports_empty_and_partial_pages() {
        let empty = compare_runs_with_extraction(
            &[],
            &[],
            TextExtractionSummary::empty(),
            TextExtractionSummary::empty(),
        );
        assert_eq!(empty.quality, TextExtractionQuality::Empty);

        let partial = compare_runs_with_extraction(
            &[],
            &[run("Scanned", 10.0, 20.0)],
            TextExtractionSummary::empty(),
            TextExtractionSummary::from_runs(&[run("Scanned", 10.0, 20.0)], 0),
        );
        assert_eq!(partial.quality, TextExtractionQuality::Partial);

        let failed = compare_runs_with_extraction(
            &[],
            &[],
            TextExtractionSummary::failed("text page unavailable"),
            TextExtractionSummary::empty(),
        );
        assert_eq!(failed.quality, TextExtractionQuality::Suspect);
        assert_eq!(
            failed.before_extraction.error.as_deref(),
            Some("text page unavailable")
        );
    }

    #[test]
    fn oversized_positioned_text_uses_a_bounded_fallback() {
        let before = (0..5_000)
            .map(|index| run(&format!("before-{index}"), index as f32, 20.0))
            .collect::<Vec<_>>();
        let after = (0..5_000)
            .map(|index| run(&format!("after-{index}"), index as f32, 20.0))
            .collect::<Vec<_>>();

        let result = compare_runs(&before, &after);

        assert!(!result.equal);
        assert!(result.changes_truncated);
        assert_eq!(result.changes.len(), MAX_SEMANTIC_CHANGES);
        assert!(result.text_diff.truncated);
    }

    #[test]
    fn same_text_at_a_new_position_is_moved() {
        let result = compare_runs(&[run("Hello", 10.0, 20.0)], &[run("Hello", 70.0, 20.0)]);
        assert!(!result.equal);
        assert_eq!(result.changes[0].kind, SemanticChangeKind::Moved);
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].kind, SemanticChangeKind::Moved);
        assert!(result.blocks[0].before_bounds.is_some());
        assert!(result.blocks[0].after_bounds.is_some());
    }

    #[test]
    fn overlapping_runs_with_new_text_are_modified() {
        let result = compare_runs(&[run("Before", 10.0, 20.0)], &[run("After", 10.0, 20.0)]);
        assert!(!result.equal);
        assert_eq!(result.changes[0].kind, SemanticChangeKind::Modified);
    }

    #[test]
    fn modified_text_exposes_changed_fragment_bounds() {
        let before = TextRun::with_fragments(
            "The review.",
            SemanticBounds::new(10.0, 20.0, 90.0, 12.0),
            vec![
                TextFragment::new("The", SemanticBounds::new(10.0, 20.0, 22.0, 12.0)),
                TextFragment::new("review", SemanticBounds::new(40.0, 20.0, 42.0, 12.0)),
                TextFragment::new(".", SemanticBounds::new(82.0, 20.0, 4.0, 12.0)),
            ],
        );
        let after = TextRun::with_fragments(
            "The release.",
            SemanticBounds::new(10.0, 20.0, 98.0, 12.0),
            vec![
                TextFragment::new("The", SemanticBounds::new(10.0, 20.0, 22.0, 12.0)),
                TextFragment::new("release", SemanticBounds::new(40.0, 20.0, 50.0, 12.0)),
                TextFragment::new(".", SemanticBounds::new(90.0, 20.0, 4.0, 12.0)),
            ],
        );

        let result = compare_runs(&[before], &[after]);
        let change = &result.changes[0];

        assert_eq!(change.kind, SemanticChangeKind::Modified);
        assert_eq!(change.before_focus_bounds.unwrap().width, 42.0);
        assert_eq!(change.after_focus_bounds.unwrap().width, 50.0);
    }

    #[test]
    fn positional_matching_prefers_similar_text_after_an_insertion() {
        let before = [
            run(
                "It reports visual regions and positioned text changes.",
                10.0,
                20.0,
            ),
            run("The default renderer is PDFium.", 10.0, 40.0),
        ];
        let after = [
            run(
                "It reports visual regions, text hunks, and positioned text changes.",
                10.0,
                20.0,
            ),
            run(
                "The default renderer is PDFium with conservative page matching.",
                10.0,
                40.0,
            ),
            run("The React viewer opens in spatial review mode.", 10.0, 60.0),
        ];

        let result = compare_runs(&before, &after);

        assert_eq!(result.changes.len(), 3);
        assert_eq!(result.changes[0].kind, SemanticChangeKind::Added);
        assert_eq!(result.changes[1].kind, SemanticChangeKind::Added);
        assert_eq!(
            result.changes[0].after_text.as_deref(),
            Some(", text hunks,")
        );
        assert_eq!(
            result.changes[1].after_text.as_deref(),
            Some("with conservative page matching")
        );
        assert!(result.changes[0].before_text.is_none());
        assert!(result.changes[0].before_bounds.is_none());
        assert_eq!(
            result.changes[2].after_text.as_deref(),
            Some(after[2].text.as_str())
        );
    }

    #[test]
    fn positional_matching_handles_realistic_line_widths() {
        let before = [
            TextRun::new(
                "It reports visual regions and positioned text changes.",
                SemanticBounds::new(73.638, 151.07599, 417.0059, 16.866028),
            ),
            TextRun::new(
                "The default renderer is PDFium.",
                SemanticBounds::new(72.252, 186.896, 254.26802, 13.356018),
            ),
        ];
        let after = [
            TextRun::new(
                "It reports visual regions, text hunks, and positioned text changes.",
                SemanticBounds::new(73.638, 151.07599, 514.0619, 16.866028),
            ),
            TextRun::new(
                "The default renderer is PDFium with conservative page matching.",
                SemanticBounds::new(72.252, 186.896, 520.37994, 17.04602),
            ),
            TextRun::new(
                "The React viewer opens in spatial review mode.",
                SemanticBounds::new(72.252, 259.076, 380.3219, 16.632019),
            ),
        ];

        let result = compare_runs(&before, &after);

        assert_eq!(result.changes[0].kind, SemanticChangeKind::Added);
        assert_eq!(result.changes[1].kind, SemanticChangeKind::Added);
        assert_eq!(
            result.changes[1].after_text.as_deref(),
            Some("with conservative page matching")
        );
        assert_eq!(result.changes[2].kind, SemanticChangeKind::Added);
    }

    #[test]
    fn unmatched_runs_are_added_and_removed() {
        let result = compare_runs(&[run("Before", 10.0, 20.0)], &[run("After", 100.0, 100.0)]);
        assert_eq!(result.changes.len(), 2);
        assert_eq!(result.changes[0].kind, SemanticChangeKind::Removed);
        assert_eq!(result.changes[1].kind, SemanticChangeKind::Added);
        assert_eq!(result.blocks.len(), 2);
        assert_eq!(result.blocks[0].kind, SemanticChangeKind::Removed);
        assert!(result.blocks[0].before_bounds.is_some());
        assert!(result.blocks[0].after_bounds.is_none());
        assert_eq!(result.blocks[1].kind, SemanticChangeKind::Added);
        assert!(result.blocks[1].before_bounds.is_none());
        assert!(result.blocks[1].after_bounds.is_some());
    }

    #[test]
    fn matched_line_insertions_are_one_sided_but_replacements_are_two_sided() {
        let insertion = compare_runs(
            &[run("The report is ready.", 10.0, 20.0)],
            &[run("The report is now ready.", 10.0, 20.0)],
        );
        assert_eq!(insertion.changes[0].kind, SemanticChangeKind::Added);
        assert!(insertion.changes[0].before_bounds.is_none());
        assert!(insertion.changes[0].after_bounds.is_some());
        assert_eq!(insertion.changes[0].after_text.as_deref(), Some("now"));
        assert_eq!(insertion.blocks.len(), 1);
        assert_eq!(insertion.blocks[0].kind, SemanticChangeKind::Added);
        assert!(insertion.blocks[0].before_bounds.is_none());
        assert!(insertion.blocks[0].after_bounds.is_some());
        assert_eq!(insertion.blocks[0].after_text.as_deref(), Some("now"));
        assert_eq!(insertion.blocks[0].text_diff.changed_lines, 2);

        let replacement = compare_runs(
            &[run("The report is ready.", 10.0, 20.0)],
            &[run("The report is final.", 10.0, 20.0)],
        );
        assert_eq!(replacement.changes[0].kind, SemanticChangeKind::Modified);
        assert!(replacement.changes[0].before_bounds.is_some());
        assert!(replacement.changes[0].after_bounds.is_some());
        assert_eq!(replacement.blocks.len(), 1);
        assert_eq!(replacement.blocks[0].kind, SemanticChangeKind::Modified);
        assert!(replacement.blocks[0].before_bounds.is_some());
        assert!(replacement.blocks[0].after_bounds.is_some());
    }

    #[test]
    fn semantic_blocks_group_a_pure_multiline_insertion() {
        let before = [
            run("Stable heading.", 10.0, 20.0),
            run("Stable closing note.", 10.0, 80.0),
        ];
        let after = [
            run("Stable heading.", 10.0, 20.0),
            run("Inserted paragraph one.", 10.0, 40.0),
            run("Inserted paragraph two.", 10.0, 60.0),
            run("Stable closing note.", 10.0, 80.0),
        ];

        let result = compare_runs(&before, &after);

        assert_eq!(result.blocks.len(), 1);
        let block = &result.blocks[0];
        assert_eq!(block.kind, SemanticChangeKind::Added);
        assert!(block.before_text.is_none());
        assert_eq!(
            block.after_text.as_deref(),
            Some("Inserted paragraph one. Inserted paragraph two.")
        );
        assert!(block.before_bounds.is_none());
        assert!(block.after_bounds.is_some());
        assert_eq!(block.text_diff.hunks.len(), 1);
        assert_eq!(block.text_diff.changed_lines, 2);
        assert!(block.text_diff.hunks[0]
            .lines
            .iter()
            .all(|line| line.kind == TextDiffLineKind::Added));
    }

    #[test]
    fn structural_blocks_classify_lists_and_table_rows() {
        let list = compare_runs(
            &[run("- stable item", 10.0, 20.0)],
            &[run("- revised item", 10.0, 20.0)],
        );
        assert_eq!(list.blocks.len(), 1);
        assert_eq!(list.blocks[0].structure, SemanticTextBlockKind::ListItem);
        assert!(list.blocks[0].confidence >= 0.0);

        let table_before = TextRun::with_fragments(
            "Name Value Total",
            SemanticBounds::new(10.0, 40.0, 180.0, 12.0),
            vec![
                TextFragment::new("Name", SemanticBounds::new(10.0, 40.0, 30.0, 12.0)),
                TextFragment::new("Value", SemanticBounds::new(80.0, 40.0, 30.0, 12.0)),
                TextFragment::new("Total", SemanticBounds::new(150.0, 40.0, 30.0, 12.0)),
            ],
        );
        let table_after = TextRun::with_fragments(
            "Name Amount Total",
            SemanticBounds::new(10.0, 40.0, 200.0, 12.0),
            vec![
                TextFragment::new("Name", SemanticBounds::new(10.0, 40.0, 30.0, 12.0)),
                TextFragment::new("Amount", SemanticBounds::new(80.0, 40.0, 45.0, 12.0)),
                TextFragment::new("Total", SemanticBounds::new(150.0, 40.0, 30.0, 12.0)),
            ],
        );
        let table = compare_runs(&[table_before], &[table_after]);
        assert_eq!(table.blocks.len(), 1);
        assert_eq!(table.blocks[0].structure, SemanticTextBlockKind::TableRow);
    }

    #[test]
    fn structural_blocks_treat_split_and_merged_lines_as_reflow() {
        let result = compare_runs(
            &[run("Alpha beta gamma", 10.0, 20.0)],
            &[run("Alpha beta", 10.0, 20.0), run("gamma", 10.0, 36.0)],
        );

        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].kind, SemanticChangeKind::Reflowed);
        assert_eq!(result.blocks[0].structure, SemanticTextBlockKind::Paragraph);
        assert!((0.0..=1.0).contains(&result.blocks[0].confidence));
    }

    #[test]
    fn text_diff_keeps_context_and_marks_changed_words() {
        let before = [
            run("Quarterly release review.", 10.0, 20.0),
            run("The contract is ready for review.", 10.0, 40.0),
            run("The owner signs below.", 10.0, 60.0),
        ];
        let after = [
            run("Quarterly release review.", 10.0, 20.0),
            run("The contract is ready for release.", 10.0, 40.0),
            run("The owner signs below.", 10.0, 60.0),
        ];

        let result = compare_runs(&before, &after);
        let hunk = &result.text_diff.hunks[0];

        assert_eq!(result.text_diff.changed_lines, 2);
        assert_eq!(hunk.lines.len(), 4);
        assert_eq!(hunk.lines[0].kind, TextDiffLineKind::Context);
        assert_eq!(hunk.lines[1].kind, TextDiffLineKind::Removed);
        assert_eq!(hunk.lines[2].kind, TextDiffLineKind::Added);
        assert_eq!(hunk.lines[3].kind, TextDiffLineKind::Context);
        assert!(hunk.lines[1]
            .spans
            .iter()
            .any(|span| span.kind == TextDiffSpanKind::Removed));
        assert!(hunk.lines[2]
            .spans
            .iter()
            .any(|span| span.kind == TextDiffSpanKind::Added));
        assert_eq!(
            hunk.lines[1]
                .spans
                .iter()
                .map(|span| (span.kind, span.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (TextDiffSpanKind::Equal, "The contract is ready for"),
                (TextDiffSpanKind::Removed, " review"),
                (TextDiffSpanKind::Equal, "."),
            ]
        );
    }

    #[test]
    fn text_diff_context_can_be_disabled() {
        let before = [
            run("Stable heading.", 10.0, 20.0),
            run("The original sentence.", 10.0, 40.0),
            run("Stable closing note.", 10.0, 60.0),
        ];
        let after = [
            run("Stable heading.", 10.0, 20.0),
            run("The revised sentence.", 10.0, 40.0),
            run("Stable closing note.", 10.0, 60.0),
        ];

        let result = compare_runs_with_extraction_and_options(
            &before,
            &after,
            TextExtractionSummary::from_runs(&before, 0),
            TextExtractionSummary::from_runs(&after, 0),
            TextDiffOptions { context_lines: 0 },
        );

        assert_eq!(result.text_diff.hunks.len(), 1);
        assert!(result.text_diff.hunks[0]
            .lines
            .iter()
            .all(|line| line.kind != TextDiffLineKind::Context));
    }

    #[test]
    fn identical_word_flow_is_reported_as_reflowed_not_added_and_removed() {
        let before = [
            run("Experienced engineer with ten", 10.0, 20.0),
            run("years building reliable systems.", 10.0, 36.0),
            run("Education", 10.0, 70.0),
        ];
        let after = [
            run("Experienced engineer with", 10.0, 20.0),
            run("ten years building reliable systems.", 10.0, 36.0),
            run("Education", 10.0, 70.0),
        ];

        let result = compare_runs(&before, &after);

        assert!(!result.equal);
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].kind, SemanticChangeKind::Reflowed);
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].kind, SemanticChangeKind::Reflowed);
        assert!(result.blocks[0].text_diff.hunks.is_empty());
        assert_eq!(result.text_diff.changed_lines, 0);
        assert!(result.text_diff.hunks.is_empty());
    }

    #[test]
    fn reflowed_changed_content_keeps_word_hunks_compact() {
        let before = [
            run("Experienced engineer with ten", 10.0, 20.0),
            run("years building reliable systems and", 10.0, 36.0),
            run("shipping tools.", 10.0, 52.0),
            run("Education", 10.0, 86.0),
        ];
        let after = [
            run("Experienced engineer with eleven years", 10.0, 20.0),
            run("building reliable systems and shipping", 10.0, 36.0),
            run("tools.", 10.0, 52.0),
            run("Education", 10.0, 86.0),
        ];

        let result = compare_runs(&before, &after);
        let lines = &result.text_diff.hunks[0].lines;

        assert_eq!(lines.len(), 2);
        assert!(lines[0]
            .spans
            .iter()
            .any(|span| span.kind == TextDiffSpanKind::Removed && span.text.contains("ten")));
        assert!(lines[1]
            .spans
            .iter()
            .any(|span| span.kind == TextDiffSpanKind::Added && span.text.contains("eleven")));
    }

    #[test]
    fn text_diff_marks_words_across_a_replacement_block() {
        let before = [
            run(
                "It reports visual regions and positioned text changes.",
                10.0,
                20.0,
            ),
            run("The default renderer is PDFium.", 10.0, 40.0),
        ];
        let after = [
            run(
                "It reports visual regions, text hunks, and positioned text changes.",
                10.0,
                20.0,
            ),
            run(
                "The default renderer is PDFium with conservative page matching.",
                10.0,
                40.0,
            ),
            run("The React viewer opens in spatial review mode.", 10.0, 60.0),
        ];

        let result = compare_runs(&before, &after);
        let lines = &result.text_diff.hunks[0].lines;

        assert!(lines.iter().any(|line| {
            line.kind == TextDiffLineKind::Added
                && line
                    .spans
                    .iter()
                    .any(|span| span.kind == TextDiffSpanKind::Equal)
                && line
                    .spans
                    .iter()
                    .any(|span| span.kind == TextDiffSpanKind::Added)
        }));
        assert!(lines.iter().any(|line| {
            line.kind == TextDiffLineKind::Removed
                && line
                    .spans
                    .iter()
                    .all(|span| span.kind == TextDiffSpanKind::Equal)
        }));
    }
}
