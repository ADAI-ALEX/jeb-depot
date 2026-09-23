//! The request pipeline of `jeb/server.py::evaluate`: validate -> plans -> engine -> answers (+ usage, debug),
//! plus a `telemetry` extension with timings and full-precision distributions for the game's HUD and benchmarks.

use crate::decide::{build_answers, Calibration, QuestionDetail, Scored};
use crate::engine::{EngineError, EngineTimings, LlamaEngine, Scheduling};
use crate::prompt::{build_plans, system_head, HfTokenizer, Labeler, PlanError, Tokenize, TEMPLATE_VERSION};
use crate::schema::{CalibrationMode, SystemOneRequest, SystemOneResponse, Usage};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;

pub const MODEL_ID: &str = "jeb-4b";
pub const MODEL_ALIASES: [&str; 3] = ["jeb-latest", "openjev-latest", "jev-latest"];
pub const MAX_QUESTIONS: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Engine(#[from] EngineError),
}

impl ServiceError {
    /// Status code and error type of the upstream API (422 invalid request, 529 engine unavailable).
    pub fn status(&self) -> (u16, &'static str) {
        match self {
            ServiceError::Invalid(_) => (422, "invalid_request_error"),
            ServiceError::Engine(_) => (529, "overloaded_error"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Telemetry {
    pub engine: EngineTimings,
    /// Tokenization and prompt building on this side.
    pub prepare_ms: f64,
    /// Everything from request received to answers assembled.
    pub total_ms: f64,
    pub prompts: usize,
    pub prefix_tokens: usize,
    pub permutations: usize,
    pub scheduling: Scheduling,
    pub questions: Vec<(String, QuestionDetail)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DecideOutput {
    #[serde(flatten)]
    pub response: SystemOneResponse,
    pub telemetry: Telemetry,
}

pub struct JebService {
    labeler: Labeler<HfTokenizer>,
    pub engine: LlamaEngine,
    calibration: Calibration,
}

impl JebService {
    pub fn new(tokenizer: HfTokenizer, engine_url: &str, api_key: &str, calibration: Calibration) -> Self {
        let system_ids = tokenizer.encode(&system_head());
        JebService { labeler: Labeler::new(tokenizer), engine: LlamaEngine::new(engine_url, api_key, system_ids), calibration }
    }

    pub fn tokenizer(&self) -> &HfTokenizer {
        &self.labeler.tokenizer
    }

    pub fn calibration_source(&self) -> &str {
        &self.calibration.source
    }

    pub async fn decide(&self, body: &Value, scheduling: Scheduling) -> Result<DecideOutput, ServiceError> {
        let t0 = Instant::now();
        let req = SystemOneRequest::from_value(body).map_err(|e| ServiceError::Invalid(e.0))?;
        if req.model != MODEL_ID && !MODEL_ALIASES.contains(&req.model.as_str()) {
            return Err(ServiceError::Invalid(format!("unknown model {:?}; this server answers for {MODEL_ID}", req.model)));
        }
        if req.questions.len() > MAX_QUESTIONS {
            return Err(ServiceError::Invalid(format!("at most {MAX_QUESTIONS} questions per request")));
        }
        let opts = req.options.clone().unwrap_or_default();
        let permutations = opts.permutations.map(|p| p as usize).or(self.calibration.permutations).unwrap_or(1).max(1);
        let (plans, prefix) = build_plans(&req, &self.labeler, permutations).map_err(|e| match e {
            PlanError::Label(..) | PlanError::Invalid(_) => ServiceError::Invalid(e.to_string()),
        })?;
        let prepare_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let (results, engine_timings) = self.engine.score(&prefix.ids, &plans, scheduling).await?;

        let cal = if opts.calibration == CalibrationMode::Calibrated { Some(&self.calibration) } else { None };
        let scored: Vec<Scored> = plans.iter().zip(&results).map(|(p, r)| Scored { plan: p, logprobs: r.logprobs.clone(), missing: r.missing }).collect();
        let (answers, details) = build_answers(&req, &scored, cal);
        // Usage mirrors the upstream economics: the shared prefix once, then each question's own tokens.
        let usage = Usage { input_tokens: prefix.tokens + plans.iter().map(|p| p.prompt_ids.len() - p.prefix_len).sum::<usize>(), output_tokens: plans.len() };
        let debug = if opts.debug {
            let mut d = serde_json::Map::new();
            for (qid, det) in &details {
                d.insert(
                    qid.clone(),
                    json!({
                        "kind": det.kind,
                        "in_set_mass": crate::decide::round4(det.in_set_mass),
                        "permutations": det.presentations.iter().map(|p| json!({"labels": p.labels, "targets": p.targets, "logprobs": p.logprobs})).collect::<Vec<_>>(),
                        "prompts": plans.iter().filter(|p| &p.qid == qid).map(|p| p.text.clone()).collect::<Vec<_>>(),
                    }),
                );
            }
            d.insert(
                "_engine".into(),
                json!({
                    "name": "llama-server",
                    "prompts_sent": plans.len(),
                    "engine_prompt_tokens": engine_timings.tokens_evaluated,
                    "prefix_tokens": prefix.tokens,
                    "permutations": permutations,
                    "missing_label_logprobs": results.iter().map(|r| r.missing).sum::<usize>(),
                    "template": TEMPLATE_VERSION,
                    "calibration": if cal.is_some() { self.calibration.source.as_str() } else { "raw" },
                    "scheduling": scheduling,
                }),
            );
            Some(Value::Object(d))
        } else {
            None
        };
        let telemetry = Telemetry {
            engine: engine_timings,
            prepare_ms,
            total_ms: t0.elapsed().as_secs_f64() * 1000.0,
            prompts: plans.len(),
            prefix_tokens: prefix.tokens,
            permutations,
            scheduling,
            questions: details,
        };
        Ok(DecideOutput { response: SystemOneResponse { model: MODEL_ID.into(), answers, usage, debug }, telemetry })
    }
}
