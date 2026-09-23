//! From label log-probabilities to typed answers — a port of `jeb/decide.py` (szybkie-ai/jeb@4990c9a).
//!
//! The engine returns, for each plan, the log-probability of every label token at the answer position
//! (log-softmax over the full vocabulary). Renormalising over the labels is the restricted softmax; the mass the
//! labels had before renormalising ("in-set mass") tells us whether the model followed the format at all.
//! Calibration (a temperature per primitive and per-position log-priors) is applied on the label logits; the
//! released JEB-4B is served with the identity calibration.

use crate::prompt::{Plan, LETTERS, NO, YES};
use crate::schema::{Answer, Kind, Question, SystemOneRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub fn softmax(xs: &[f64]) -> Vec<f64> {
    let m = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let es: Vec<f64> = xs.iter().map(|x| (x - m).exp()).collect();
    let z: f64 = es.iter().sum();
    es.into_iter().map(|e| e / z).collect()
}

/// The names calibration priors are keyed by: letters for choice, positions for score, Yes/No for noul.
pub fn position_labels(kind: Kind, n: usize) -> Vec<String> {
    match kind {
        Kind::Noul => vec![YES.into(), NO.into()],
        Kind::Choice => LETTERS[..n].chars().map(|c| c.to_string()).collect(),
        Kind::Score => (0..n).map(|i| format!("pos{i}")).collect(),
    }
}

/// Per-primitive temperature and per-position log-prior corrections (identity by default).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calibration {
    #[serde(default = "default_temperature")]
    pub temperature: HashMap<String, f64>,
    #[serde(default)]
    pub log_prior: HashMap<String, HashMap<String, f64>>,
    #[serde(default)]
    pub permutations: Option<usize>,
    #[serde(skip)]
    pub source: String,
}

fn default_temperature() -> HashMap<String, f64> {
    [("noul", 1.0), ("choice", 1.0), ("score", 1.0)].into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

impl Default for Calibration {
    fn default() -> Self {
        Calibration { temperature: default_temperature(), log_prior: HashMap::new(), permutations: None, source: "identity".into() }
    }
}

impl Calibration {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut c: Calibration = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut t = default_temperature();
        t.extend(c.temperature.drain());
        c.temperature = t;
        c.source = path.display().to_string();
        Ok(c)
    }

    pub fn is_identity(&self) -> bool {
        self.temperature.values().all(|t| *t == 1.0) && self.log_prior.values().all(|m| m.values().all(|v| *v == 0.0))
    }

    pub fn apply(&self, kind: Kind, labels: &[String], logprobs: &[f64]) -> Vec<f64> {
        let t = *self.temperature.get(kind.as_str()).unwrap_or(&1.0);
        let prior = self.log_prior.get(kind.as_str());
        labels
            .iter()
            .zip(logprobs)
            .map(|(lab, lp)| (lp - prior.and_then(|p| p.get(lab)).copied().unwrap_or(0.0)) / t)
            .collect()
    }
}

// --------------------------------------------------------------------------- confidence

/// Peak probability rescaled so uniform -> 0 and certain -> 1.
pub fn choice_confidence(probs: &[f64]) -> f64 {
    let n = probs.len();
    if n == 1 {
        return 1.0;
    }
    let u = 1.0 / n as f64;
    let peak = probs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    ((peak - u) / (1.0 - u)).max(0.0)
}

/// Concentration around the modal level: 1 - MAD-from-mode / MAD of the uniform distribution.
pub fn score_confidence(probs: &[f64]) -> f64 {
    let n = probs.len();
    if n == 1 {
        return 1.0;
    }
    let mode = argmax(probs);
    let mad: f64 = probs.iter().enumerate().map(|(i, p)| p * (i as f64 - mode as f64).abs()).sum();
    let center = (n as f64 - 1.0) / 2.0;
    let uniform_mad: f64 = (0..n).map(|i| (i as f64 - center).abs()).sum::<f64>() / n as f64;
    (1.0 - mad / uniform_mad).max(0.0)
}

/// Index of the first maximum (Python's `max` keeps the first of equal elements).
pub fn argmax(xs: &[f64]) -> usize {
    let mut best = 0;
    for (i, x) in xs.iter().enumerate() {
        if *x > xs[best] {
            best = i;
        }
    }
    best
}

/// Python's `round(x, 4)`: both CPython and Rust's `{:.4}` round the exact binary value, ties to even.
pub fn round4(x: f64) -> f64 {
    format!("{x:.4}").parse().unwrap_or(x)
}

// --------------------------------------------------------------------------- combination

/// Target -> probability for one presentation, after optional calibration on the label logits.
pub fn distribution(kind: Kind, labels: &[String], targets: &[String], logprobs: &[f64], cal: Option<&Calibration>) -> Vec<(String, f64)> {
    let logits = match cal {
        Some(c) => c.apply(kind, labels, logprobs),
        None => logprobs.to_vec(),
    };
    targets.iter().cloned().zip(softmax(&logits)).collect()
}

/// Average presentations over targets (option keys / level indices / yes-no) and renormalise.
pub fn combine(dists: &[Vec<(String, f64)>]) -> Vec<(String, f64)> {
    let keys: Vec<String> = dists[0].iter().map(|(k, _)| k.clone()).collect();
    let avg: Vec<(String, f64)> = keys
        .iter()
        .map(|k| {
            let s: f64 = dists.iter().map(|d| d.iter().find(|(t, _)| t == k).map(|(_, p)| *p).unwrap_or(0.0)).sum();
            (k.clone(), s / dists.len() as f64)
        })
        .collect();
    let z: f64 = avg.iter().map(|(_, v)| v).sum();
    avg.into_iter().map(|(k, v)| (k, v / z)).collect()
}

/// One scored presentation: the plan and its label log-probabilities (aligned with `plan.label_ids`).
pub struct Scored<'a> {
    pub plan: &'a Plan,
    pub logprobs: Vec<f64>,
    pub missing: usize,
}

/// Full-precision view of one question's answer, for telemetry and the HUD (the wire answer is rounded).
#[derive(Debug, Clone, Serialize)]
pub struct QuestionDetail {
    pub kind: Kind,
    /// Target -> probability after presentation averaging (option keys, level indices as strings, or yes/no).
    pub probabilities: Vec<(String, f64)>,
    pub confidence: f64,
    /// Mean share of probability the label tokens held before renormalising (format adherence).
    pub in_set_mass: f64,
    /// Labels the engine did not report in its top list (filled with a floor, as upstream).
    pub missing_labels: usize,
    pub presentations: Vec<PresentationDetail>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresentationDetail {
    pub labels: Vec<String>,
    pub targets: Vec<String>,
    pub logprobs: Vec<f64>,
}

pub fn build_answers(req: &SystemOneRequest, scored: &[Scored], cal: Option<&Calibration>) -> (Map<String, Value>, Vec<(String, QuestionDetail)>) {
    let mut answers = Map::new();
    let mut details = Vec::new();
    for (qid, q) in &req.questions {
        let group: Vec<&Scored> = scored.iter().filter(|s| &s.plan.qid == qid).collect();
        let kind = group[0].plan.kind;
        let dists: Vec<Vec<(String, f64)>> = group
            .iter()
            .map(|s| distribution(kind, &position_labels(kind, s.plan.label_ids.len()), &s.plan.targets, &s.logprobs, cal))
            .collect();
        let masses: Vec<f64> = group.iter().map(|s| s.logprobs.iter().map(|lp| lp.exp()).sum()).collect();
        let avg = combine(&dists);
        let probs: Vec<f64> = avg.iter().map(|(_, p)| *p).collect();
        let (answer, conf) = match q {
            Question::Noul { .. } => {
                let yes = avg.iter().find(|(k, _)| k == "yes").map(|(_, p)| *p).unwrap_or(0.0);
                (Answer::Noul { noul: round4(yes) }, (2.0 * yes - 1.0).abs())
            }
            Question::Choice { .. } => {
                let best = avg[argmax(&probs)].0.clone();
                let conf = choice_confidence(&probs);
                let p: Map<String, Value> = avg.iter().map(|(k, v)| (k.clone(), Value::from(round4(*v)))).collect();
                (Answer::Choice { choice: best, probabilities: p, confidence: round4(conf) }, conf)
            }
            Question::Score { criteria, .. } => {
                let n = criteria.len();
                let ordered: Vec<f64> = (0..n).map(|i| avg.iter().find(|(k, _)| *k == i.to_string()).map(|(_, p)| *p).unwrap_or(0.0)).collect();
                let conf = score_confidence(&ordered);
                let score: f64 = ordered.iter().enumerate().map(|(i, p)| i as f64 * p).sum();
                let legend: Map<String, Value> = criteria.iter().enumerate().map(|(i, l)| (i.to_string(), l.clone())).collect();
                let p: Map<String, Value> = ordered.iter().enumerate().map(|(i, v)| (i.to_string(), Value::from(round4(*v)))).collect();
                (Answer::Score { score: round4(score), legend, probabilities: p, confidence: round4(conf) }, conf)
            }
        };
        let full_probs = match q {
            // Levels in their natural order for the HUD, whatever order presentations used.
            Question::Score { criteria, .. } => (0..criteria.len()).map(|i| (i.to_string(), avg.iter().find(|(k, _)| *k == i.to_string()).map(|(_, p)| *p).unwrap_or(0.0))).collect(),
            _ => avg.clone(),
        };
        details.push((
            qid.clone(),
            QuestionDetail {
                kind,
                probabilities: full_probs,
                confidence: conf,
                in_set_mass: masses.iter().sum::<f64>() / masses.len() as f64,
                missing_labels: group.iter().map(|s| s.missing).sum(),
                presentations: group
                    .iter()
                    .map(|s| PresentationDetail { labels: s.plan.labels.clone(), targets: s.plan.targets.clone(), logprobs: s.logprobs.clone() })
                    .collect(),
            },
        ));
        answers.insert(qid.clone(), serde_json::to_value(answer).expect("answer serializes"));
    }
    (answers, details)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confidences_match_upstream_definitions() {
        assert!((choice_confidence(&[0.25, 0.25, 0.25, 0.25]) - 0.0).abs() < 1e-12);
        assert!((choice_confidence(&[1.0, 0.0]) - 1.0).abs() < 1e-12);
        assert!((choice_confidence(&[0.9758, 0.0242]) - 0.9516).abs() < 1e-9);
        // upstream README example: anger [0.0772, 0.5852, 0.3376] -> 0.3778
        assert!((score_confidence(&[0.0772, 0.5852, 0.3376]) - 0.3778).abs() < 1e-4);
    }

    #[test]
    fn combine_averages_by_target() {
        let a = vec![("x".to_string(), 0.8), ("y".to_string(), 0.2)];
        let b = vec![("y".to_string(), 0.4), ("x".to_string(), 0.6)];
        let c = combine(&[a, b]);
        assert_eq!(c[0].0, "x");
        assert!((c[0].1 - 0.7).abs() < 1e-12 && (c[1].1 - 0.3).abs() < 1e-12);
    }

    #[test]
    fn rounding_matches_python_round() {
        // CPython 3: round(x, 4) for these inputs
        for (x, want) in [(0.12345, 0.1235), (0.9515, 0.9515), (0.33337, 0.3334), (0.00005, 0.0001), (0.00015, 0.0001), (1.00005, 1.0001), (0.99995, 1.0)] {
            assert_eq!(round4(x), want, "{x}");
        }
    }
}
