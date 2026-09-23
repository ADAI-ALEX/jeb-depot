//! System One wire format, 1:1 with the official JEB server (`jeb/schema.py`, szybkie-ai/jeb@4990c9a).
//!
//! Requests carry a `state` (string, object or array), a `model` id and an ordered map of typed questions.
//! Validation mirrors the pydantic models: a choice needs >= 2 options with non-empty keys, a score >= 2 levels,
//! noul criteria only know `true` / `false`. JEB extensions live under `options`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Maximum options / levels per question (one letter label each).
pub const MAX_OPTIONS: usize = 26;

#[derive(Debug, Clone, PartialEq)]
pub enum Question {
    Noul { instructions: Value, criteria: Option<NoulCriteria> },
    /// Option key -> rubric (string, JSON structure, or null). Order is the caller's.
    Choice { instructions: Value, criteria: Vec<(String, Value)> },
    /// Ordered levels, lowest first.
    Score { instructions: Value, criteria: Vec<Value> },
}

impl Question {
    pub fn kind(&self) -> Kind {
        match self {
            Question::Noul { .. } => Kind::Noul,
            Question::Choice { .. } => Kind::Choice,
            Question::Score { .. } => Kind::Score,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Noul,
    Choice,
    Score,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Noul => "noul",
            Kind::Choice => "choice",
            Kind::Score => "score",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoulCriteria {
    #[serde(default)]
    pub r#true: Option<String>,
    #[serde(default)]
    pub r#false: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationMode {
    Raw,
    #[default]
    Calibrated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Options {
    /// Option orderings averaged per choice/score question (1..=8).
    #[serde(default)]
    pub permutations: Option<u8>,
    #[serde(default)]
    pub calibration: CalibrationMode,
    #[serde(default)]
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SystemOneRequest {
    pub state: Value,
    pub model: String,
    /// Question id -> question, in request order.
    pub questions: Vec<(String, Question)>,
    pub options: Option<Options>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
#[error("{0}")]
pub struct ValidationError(pub String);

fn err<T>(msg: impl Into<String>) -> Result<T, ValidationError> {
    Err(ValidationError(msg.into()))
}

/// `Text = str | dict | list`: instructions and criteria may be plain strings or JSON structure.
fn check_text(v: &Value, what: &str) -> Result<(), ValidationError> {
    match v {
        Value::String(_) | Value::Object(_) | Value::Array(_) => Ok(()),
        _ => err(format!("{what}: expected a string, object or array")),
    }
}

impl SystemOneRequest {
    /// Parse and validate a request body (a JSON object).
    pub fn from_value(body: &Value) -> Result<Self, ValidationError> {
        let obj = match body.as_object() {
            Some(o) => o,
            None => return err("request body must be a JSON object"),
        };
        let state = match obj.get("state") {
            Some(v) => {
                check_text(v, "state")?;
                v.clone()
            }
            None => return err("state: field required"),
        };
        let model = match obj.get("model") {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return err("model: expected a string"),
            None => return err("model: field required"),
        };
        if obj.get("images").map(|v| !v.is_null()).unwrap_or(false) {
            return err("images: this build serves the text-only JEB-4B; images are not supported");
        }
        let qmap = match obj.get("questions") {
            Some(Value::Object(m)) => m,
            Some(_) => return err("questions: expected an object"),
            None => return err("questions: field required"),
        };
        if qmap.is_empty() {
            return err("questions: at least one question is required");
        }
        let mut questions = Vec::with_capacity(qmap.len());
        for (qid, q) in qmap {
            questions.push((qid.clone(), parse_question(qid, q)?));
        }
        let options = match obj.get("options") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let o: Options = serde_json::from_value(v.clone()).map_err(|e| ValidationError(format!("options: {e}")))?;
                if let Some(p) = o.permutations {
                    if !(1..=8).contains(&p) {
                        return err("options.permutations: must be between 1 and 8");
                    }
                }
                Some(o)
            }
        };
        Ok(SystemOneRequest { state, model, questions, options })
    }
}

fn parse_question(qid: &str, q: &Value) -> Result<Question, ValidationError> {
    let o = match q.as_object() {
        Some(o) => o,
        None => return err(format!("questions.{qid}: expected an object")),
    };
    for k in o.keys() {
        if !matches!(k.as_str(), "type" | "instructions" | "criteria") {
            return err(format!("questions.{qid}.{k}: extra fields not permitted"));
        }
    }
    let instructions = match o.get("instructions") {
        Some(v) => {
            check_text(v, &format!("questions.{qid}.instructions"))?;
            v.clone()
        }
        None => return err(format!("questions.{qid}.instructions: field required")),
    };
    let criteria = o.get("criteria").filter(|v| !v.is_null());
    match o.get("type").and_then(Value::as_str) {
        Some("noul") => {
            let criteria = match criteria {
                None => None,
                Some(v) => Some(
                    serde_json::from_value::<NoulCriteria>(v.clone())
                        .map_err(|e| ValidationError(format!("questions.{qid}.criteria: {e}")))?,
                ),
            };
            Ok(Question::Noul { instructions, criteria })
        }
        Some("choice") => {
            let m: &Map<String, Value> = match criteria {
                Some(Value::Object(m)) => m,
                Some(_) => return err(format!("questions.{qid}.criteria: expected an object of option -> description")),
                None => return err(format!("questions.{qid}.criteria: field required")),
            };
            if m.len() < 2 {
                return err(format!("questions.{qid}.criteria: a choice needs at least two options"));
            }
            let mut opts = Vec::with_capacity(m.len());
            for (k, v) in m {
                if k.trim().is_empty() {
                    return err(format!("questions.{qid}.criteria: option keys must be non-empty"));
                }
                if !v.is_null() {
                    check_text(v, &format!("questions.{qid}.criteria.{k}"))?;
                }
                opts.push((k.clone(), v.clone()));
            }
            Ok(Question::Choice { instructions, criteria: opts })
        }
        Some("score") => {
            let levels = match criteria {
                Some(Value::Array(a)) => a,
                Some(_) => return err(format!("questions.{qid}.criteria: expected an ordered list of levels")),
                None => return err(format!("questions.{qid}.criteria: field required")),
            };
            if levels.len() < 2 {
                return err(format!("questions.{qid}.criteria: a score needs at least two levels"));
            }
            for (i, l) in levels.iter().enumerate() {
                check_text(l, &format!("questions.{qid}.criteria[{i}]"))?;
            }
            Ok(Question::Score { instructions, criteria: levels.clone() })
        }
        Some(t) => err(format!("questions.{qid}.type: unknown question type {t:?} (noul | choice | score)")),
        None => err(format!("questions.{qid}.type: field required")),
    }
}

// --------------------------------------------------------------------------- answers

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Noul {
        noul: f64,
    },
    Choice {
        choice: String,
        probabilities: Map<String, Value>,
        confidence: f64,
    },
    Score {
        score: f64,
        legend: Map<String, Value>,
        probabilities: Map<String, Value>,
        confidence: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: usize,
    pub output_tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemOneResponse {
    pub model: String,
    /// Question id -> typed answer, in request order.
    pub answers: Map<String, Value>,
    pub usage: Usage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<Value>,
}

/// The upstream API's error envelope: `{"detail": {"error_type", "message"}}`.
pub fn error_body(error_type: &str, message: &str) -> Value {
    serde_json::json!({"detail": {"error_type": error_type, "message": message}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Result<SystemOneRequest, ValidationError> {
        SystemOneRequest::from_value(&v)
    }

    #[test]
    fn parses_the_readme_request_in_order() {
        let r = parse(json!({"state": "s", "model": "jeb-latest", "questions": {
            "refund": {"type": "noul", "instructions": "Refund?"},
            "team": {"type": "choice", "instructions": "Team?", "criteria": {"billing": "Payments", "technical": null}},
            "anger": {"type": "score", "instructions": "Anger?", "criteria": ["Calm", "Annoyed", "Furious"]}}}))
        .unwrap();
        let ids: Vec<_> = r.questions.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(ids, ["refund", "team", "anger"]);
        match &r.questions[1].1 {
            Question::Choice { criteria, .. } => assert_eq!(criteria[0].0, "billing"),
            _ => panic!(),
        }
    }

    #[test]
    fn rejects_what_pydantic_rejects() {
        assert!(parse(json!({"state": "s", "model": "m", "questions": {}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "questions": {"q": {"type": "choice", "instructions": "i", "criteria": {"a": null}}}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "questions": {"q": {"type": "choice", "instructions": "i", "criteria": {" ": null, "b": null}}}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "questions": {"q": {"type": "score", "instructions": "i", "criteria": ["x"]}}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "questions": {"q": {"type": "noul", "instructions": "i", "criteria": {"maybe": "x"}}}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "questions": {"q": {"type": "noul", "instructions": "i", "extra": 1}}})).is_err());
        assert!(parse(json!({"state": 3, "model": "m", "questions": {"q": {"type": "noul", "instructions": "i"}}})).is_err());
        assert!(parse(json!({"state": "s", "model": "m", "options": {"permutations": 9}, "questions": {"q": {"type": "noul", "instructions": "i"}}})).is_err());
    }
}
