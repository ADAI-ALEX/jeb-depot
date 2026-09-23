//! Turn a System One request into label-scoring prompts — a port of `jeb/prompt.py` (szybkie-ai/jeb@4990c9a).
//!
//! Every question becomes one or more prompts (presentations) that end right where the model's next token is the
//! answer label. The engine returns log-probabilities for exactly the label tokens at that position; `decide` turns
//! them into typed answers. Prompts are rendered here in the model's chat format (thinking disabled) and tokenized
//! here, so the engine receives token ids and never applies a template of its own. The prefix `[system][state]` is
//! tokenized once and shared by every question of a request.
//!
//! Not ported: cache-alignment prefix padding (off by default upstream, and it changes answers) and image inputs
//! (JEB-4B is served text-only here).

use crate::schema::{Kind, Question, SystemOneRequest, MAX_OPTIONS};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub const TEMPLATE_VERSION: &str = "qwen-chat-v1";

pub const SYSTEM_PROMPT: &str = "You are a decision engine inside a software system. You will be shown a STATE and one \
QUESTION about it with labeled options. Judge the state carefully and answer with the single label of the best option. \
Output only the label.";

pub const LETTERS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
pub const YES: &str = "Yes";
pub const NO: &str = "No";

/// `<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\nSTATE:\n` — the part of every prompt before the state.
pub fn system_head() -> String {
    format!("<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\nSTATE:\n")
}

fn prefix_text(state: &str) -> String {
    format!("{}{state}\n\n", system_head())
}

/// Qwen chat format with thinking disabled: the empty think block is exactly what `enable_thinking=False` renders.
pub const SUFFIX_END: &str = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";

pub trait Tokenize: Send + Sync {
    fn encode(&self, text: &str) -> Vec<u32>;
}

/// Hugging Face `tokenizers`, loaded from the model's `tokenizer.json` (no special tokens added: Qwen has no BOS).
pub struct HfTokenizer {
    inner: tokenizers::Tokenizer,
}

impl HfTokenizer {
    pub fn from_file(path: &std::path::Path) -> Result<Self, String> {
        tokenizers::Tokenizer::from_file(path)
            .map(|inner| HfTokenizer { inner })
            .map_err(|e| format!("cannot load tokenizer {}: {e}", path.display()))
    }
}

impl Tokenize for HfTokenizer {
    fn encode(&self, text: &str) -> Vec<u32> {
        // `add_special_tokens=False`, as upstream; added tokens such as <|im_start|> are still matched in the text.
        self.inner.encode(text, false).map(|e| e.get_ids().to_vec()).unwrap_or_default()
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PlanError {
    #[error("label {0:?} is {1} tokens, need exactly one")]
    Label(String, usize),
    #[error("{0}")]
    Invalid(String),
}

/// Maps label strings to single token ids, refusing labels that are not one token.
pub struct Labeler<T: Tokenize> {
    pub tokenizer: T,
    cache: Mutex<HashMap<String, u32>>,
}

impl<T: Tokenize> Labeler<T> {
    pub fn new(tokenizer: T) -> Self {
        Labeler { tokenizer, cache: Mutex::new(HashMap::new()) }
    }

    pub fn token_id(&self, label: &str) -> Result<u32, PlanError> {
        if let Some(id) = self.cache.lock().unwrap().get(label) {
            return Ok(*id);
        }
        let ids = self.tokenizer.encode(label);
        if ids.len() != 1 {
            return Err(PlanError::Label(label.to_string(), ids.len()));
        }
        self.cache.lock().unwrap().insert(label.to_string(), ids[0]);
        Ok(ids[0])
    }
}

/// `render_text` / `render_state`: strings verbatim, anything else as `json.dumps(x, ensure_ascii=False, indent=2)`.
pub fn render_text(x: &Value) -> String {
    match x {
        Value::String(s) => s.clone(),
        other => py_json_dumps(other),
    }
}

/// Byte-exact `json.dumps(value, ensure_ascii=False, indent=2)` as CPython prints it.
pub fn py_json_dumps(v: &Value) -> String {
    let mut out = String::new();
    dump(v, 0, &mut out);
    out
}

fn dump(v: &Value, level: usize, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                out.push_str(&n.to_string());
            } else {
                out.push_str(&py_float_repr(n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(s) => dump_str(s, out),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(level + 1, out);
                dump(item, level + 1, out);
            }
            out.push('\n');
            indent(level, out);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, (k, item)) in m.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(level + 1, out);
                dump_str(k, out);
                out.push_str(": ");
                dump(item, level + 1, out);
            }
            out.push('\n');
            indent(level, out);
            out.push('}');
        }
    }
}

fn indent(level: usize, out: &mut String) {
    for _ in 0..level * 2 {
        out.push(' ');
    }
}

fn dump_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// CPython `repr(float)`: shortest round-trip digits; scientific when the decimal exponent is < -4 or >= 16.
fn py_float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{x:e}"); // e.g. "-1.2345e17", "1e-5"
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let sign = if neg { "-" } else { "" };
    if !(-4..16).contains(&exp) {
        let mut m = digits[..1].to_string();
        if digits.len() > 1 {
            m.push('.');
            m.push_str(&digits[1..]);
        }
        let esign = if exp < 0 { '-' } else { '+' };
        return format!("{sign}{m}e{esign}{:02}", exp.abs());
    }
    let n = digits.len() as i32;
    let body = if exp >= 0 {
        let int_len = exp + 1;
        if n <= int_len {
            format!("{}{}.0", digits, "0".repeat((int_len - n) as usize))
        } else {
            format!("{}.{}", &digits[..int_len as usize], &digits[int_len as usize..])
        }
    } else {
        format!("0.{}{}", "0".repeat((-exp - 1) as usize), digits)
    };
    format!("{sign}{body}")
}

/// One prompt whose next token answers one question under one option ordering.
#[derive(Debug, Clone)]
pub struct Plan {
    pub qid: String,
    pub kind: Kind,
    pub prompt_ids: Vec<u32>,
    pub prefix_len: usize,
    pub label_ids: Vec<u32>,
    /// What each label maps back to: option key, level index, or "yes"/"no".
    pub targets: Vec<String>,
    /// The label strings, aligned with `label_ids`.
    pub labels: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct PrefixInfo {
    /// Real tokens of the shared `[system][state]` prefix.
    pub tokens: usize,
    pub ids: Vec<u32>,
}

/// Cyclic rotations of option order: the label a given option gets changes each time.
pub fn choice_variants(n: usize, k: usize) -> Vec<Vec<usize>> {
    let k = k.min(n).max(1);
    (0..k).map(|r| (0..n).map(|i| (i + r) % n).collect()).collect()
}

/// (reversed?, alphabet shift). Order carries meaning, so never shuffle; reverse and shift instead.
pub fn score_variants(n: usize, k: usize) -> Vec<(bool, usize)> {
    let mut out = vec![(false, 0)];
    if k >= 2 {
        out.push((true, 0));
    }
    if k >= 3 && n + 1 <= MAX_OPTIONS {
        out.push((false, 1));
    }
    if k >= 4 && n + 1 <= MAX_OPTIONS {
        out.push((true, 1));
    }
    out
}

fn is_blank(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("")
}

fn option_lines(labels: &[String], keys: &[&str], descs: &[&Value]) -> String {
    labels
        .iter()
        .zip(keys)
        .zip(descs)
        .map(|((lab, key), desc)| if is_blank(desc) { format!("{lab}) {key}") } else { format!("{lab}) {key} — {}", render_text(desc)) })
        .collect::<Vec<_>>()
        .join("\n")
}

fn letters(from: usize, n: usize) -> Vec<String> {
    LETTERS[from..from + n].chars().map(|c| c.to_string()).collect()
}

/// Return (plans, prefix info). Errors on unservable questions (too many options, multi-token labels).
pub fn build_plans<T: Tokenize>(req: &SystemOneRequest, labeler: &Labeler<T>, permutations: usize) -> Result<(Vec<Plan>, PrefixInfo), PlanError> {
    let tok = &labeler.tokenizer;
    let prefix = prefix_text(&render_text(&req.state));
    let prefix_ids = tok.encode(&prefix);
    let info = PrefixInfo { tokens: prefix_ids.len(), ids: prefix_ids.clone() };
    let mut plans = Vec::new();

    let make = |qid: &str, kind: Kind, body: String, labels: Vec<String>, targets: Vec<String>| -> Result<Plan, PlanError> {
        let suffix = body + SUFFIX_END;
        let suffix_ids = tok.encode(&suffix);
        let label_ids = labels.iter().map(|l| labeler.token_id(l)).collect::<Result<Vec<_>, _>>()?;
        let mut prompt_ids = prefix_ids.clone();
        prompt_ids.extend_from_slice(&suffix_ids);
        Ok(Plan { qid: qid.to_string(), kind, prompt_ids, prefix_len: prefix_ids.len(), label_ids, targets, labels, text: format!("{prefix}{suffix}") })
    };

    for (qid, q) in &req.questions {
        match q {
            Question::Noul { instructions, criteria } => {
                let mut body = format!("QUESTION: {}\n", render_text(instructions));
                if let Some(c) = criteria {
                    let t = c.r#true.as_deref().filter(|s| !s.is_empty());
                    let f = c.r#false.as_deref().filter(|s| !s.is_empty());
                    if t.is_some() || f.is_some() {
                        body += &format!("{YES} means: {}\n{NO} means: {}\n", t.unwrap_or("the statement holds"), f.unwrap_or("it does not"));
                    }
                }
                body += &format!("Answer {YES} or {NO} only.");
                plans.push(make(qid, Kind::Noul, body, vec![YES.into(), NO.into()], vec!["yes".into(), "no".into()])?);
            }
            Question::Choice { instructions, criteria } => {
                if criteria.len() > MAX_OPTIONS {
                    return Err(PlanError::Invalid(format!("question {qid:?}: at most {MAX_OPTIONS} options are supported, got {}", criteria.len())));
                }
                let instr = render_text(instructions);
                for order in choice_variants(criteria.len(), permutations) {
                    let okeys: Vec<&str> = order.iter().map(|&i| criteria[i].0.as_str()).collect();
                    let descs: Vec<&Value> = order.iter().map(|&i| &criteria[i].1).collect();
                    let labels = letters(0, okeys.len());
                    let body = format!(
                        "QUESTION: {instr}\nOPTIONS:\n{}\nAnswer with the label of the best option only.",
                        option_lines(&labels, &okeys, &descs)
                    );
                    plans.push(make(qid, Kind::Choice, body, labels, okeys.iter().map(|s| s.to_string()).collect())?);
                }
            }
            Question::Score { instructions, criteria } => {
                if criteria.len() > MAX_OPTIONS {
                    return Err(PlanError::Invalid(format!("question {qid:?}: at most {MAX_OPTIONS} levels are supported, got {}", criteria.len())));
                }
                let instr = render_text(instructions);
                for (reverse, shift) in score_variants(criteria.len(), permutations) {
                    let mut idx: Vec<usize> = (0..criteria.len()).collect();
                    if reverse {
                        idx.reverse();
                    }
                    let labels = letters(shift, criteria.len());
                    let lines = labels.iter().zip(&idx).map(|(lab, &i)| format!("{lab}) {}", render_text(&criteria[i]))).collect::<Vec<_>>().join("\n");
                    let body = format!("QUESTION: {instr}\nLEVELS (ordered):\n{lines}\nAnswer with the label of the level that fits best.");
                    plans.push(make(qid, Kind::Score, body, labels, idx.iter().map(|i| i.to_string()).collect())?);
                }
            }
        }
    }
    Ok((plans, info))
}

/// How many prompts a request expands to (nouls 1, choices/scores one per presentation).
pub fn prompt_count(req: &SystemOneRequest, permutations: usize) -> usize {
    req.questions
        .iter()
        .map(|(_, q)| match q {
            Question::Noul { .. } => 1,
            Question::Choice { criteria, .. } => choice_variants(criteria.len(), permutations).len(),
            Question::Score { criteria, .. } => score_variants(criteria.len(), permutations).len(),
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_float_repr() {
        for (x, want) in [
            (1.0, "1.0"),
            (0.1, "0.1"),
            (1e-5, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (0.0001, "0.0001"),
            (1e16, "1e+16"),
            (1e15, "1000000000000000.0"),
            (123456789012345678.0, "1.2345678901234568e+17"),
            (-2.5, "-2.5"),
            (3.14159, "3.14159"),
            (100.0, "100.0"),
            (12.5, "12.5"),
        ] {
            assert_eq!(py_float_repr(x), want, "{x}");
        }
    }

    #[test]
    fn python_json_dumps_indent2() {
        let v = json!({"a": 1, "b": [1, 2.5, "x\"y\n"], "c": {}, "d": [], "é": null, "t": true});
        assert_eq!(
            py_json_dumps(&v),
            "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2.5,\n    \"x\\\"y\\n\"\n  ],\n  \"c\": {},\n  \"d\": [],\n  \"é\": null,\n  \"t\": true\n}"
        );
    }

    #[test]
    fn variants_match_upstream() {
        assert_eq!(choice_variants(3, 2), vec![vec![0, 1, 2], vec![1, 2, 0]]);
        assert_eq!(choice_variants(2, 5).len(), 2);
        assert_eq!(score_variants(3, 4), vec![(false, 0), (true, 0), (false, 1), (true, 1)]);
        assert_eq!(score_variants(26, 4), vec![(false, 0), (true, 0)]);
    }
}
