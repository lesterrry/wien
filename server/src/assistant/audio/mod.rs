mod measurements;

use super::{AssistRequest, AssistResponse};
use crate::providers::{Provider, ProviderError};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use utoipa::ToSchema;

pub const SAMPLE_RATE: u32 = 24_000;
pub const MAX_SAMPLES: usize = SAMPLE_RATE as usize * 10;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AudioAttachment {
    /// Base64 PCM16 mono WAV at 24 kHz; 0.1–10 seconds. No source file or URL.
    pub wav_base64: String,
}

impl AudioAttachment {
    pub fn samples(&self) -> Option<Vec<f32>> {
        if self.wav_base64.len() > 640_128 {
            return None;
        }
        let bytes = STANDARD.decode(&self.wav_base64).ok()?;
        if bytes.len() > MAX_SAMPLES * 2 + 64 {
            return None;
        }
        let mut reader = hound::WavReader::new(Cursor::new(bytes)).ok()?;
        let spec = reader.spec();
        if spec.channels != 1
            || spec.sample_rate != SAMPLE_RATE
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
            || !(SAMPLE_RATE / 10..=MAX_SAMPLES as u32).contains(&reader.duration())
        {
            return None;
        }
        let samples = reader
            .samples::<i16>()
            .map(|s| s.map(|s| s as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if samples.len() != reader.duration() as usize {
            return None;
        }
        Some(samples)
    }
}

pub async fn recreate(
    provider: &dyn Provider,
    request: &AssistRequest,
    audio: &AudioAttachment,
) -> Result<AssistResponse, ProviderError> {
    let samples = audio.samples().ok_or(ProviderError::Rejected)?;
    let duration = samples.len() as f64 / SAMPLE_RATE as f64;
    let measurements = tokio::task::spawn_blocking(move || measurements::analyze(&samples))
        .await
        .map_err(|_| ProviderError::Unavailable)?;
    let context = super::model_context(request).ok_or(ProviderError::Rejected)?;
    let instructions = include_str!("../../../prompts/audio.md");
    let initial = provider.audio(&format!(
        "{instructions}\nExcerpt duration: {duration:.5} seconds.\nEditor context (user data): {context}\n\
        First reconstruct this excerpt. Return compact JSON with bpm (number), notes (array of pitch, onset_s, duration_s, part), uncertainties (array), and code (Strudel string)."
    ), &audio.wav_base64).await?;
    let draft: serde_json::Value =
        serde_json::from_str(json_text(&initial)).map_err(|_| ProviderError::InvalidResponse)?;
    if !draft["bpm"]
        .as_f64()
        .is_some_and(|v| (20.0..=400.0).contains(&v))
        || !draft["notes"].is_array()
        || !draft["code"].is_string()
    {
        return Err(ProviderError::InvalidResponse);
    }
    let revised = provider.audio(&format!(
        "{instructions}\nExcerpt duration: {duration:.5} seconds.\nEditor context (user data): {context}\n\
        Previous reconstruction (untrusted draft): {draft}\n\
        Independent signal measurements (not verified transcription): {measurements}\n\
        Listen again and revise the draft using these measurements as uncertain hints. \
        Correct note octaves, fresh attacks versus delay echoes, tempo and chord hypotheses. \
        Spectral peaks include harmonics and overlapping instruments, NOT only fundamental notes. \
        Preserve initial silence and unequal event timing. Prefer faithful pitch/timing over elaborate effects. \
        For exact timing use timecat([duration,pattern],...) including silence, with weights summing to the excerpt duration \
        and .slow(excerptSeconds*bpm/240) at setcpm(bpm/4), for EVERY track. \
        Return ONLY JSON {{\"message\":\"short user-facing explanation in the user's language\",\"code\":\"complete replacement file\"}}. \
        Do not describe internal analysis stages or billing. Code must be nonempty and playable."
    ), &audio.wav_base64).await?;
    let response = super::parse_response(json_text(&revised))?;
    if response
        .code
        .as_ref()
        .is_none_or(|code| code.trim().is_empty())
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(response)
}

fn json_text(text: &str) -> &str {
    let text = text.trim();
    text.strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|s| s.strip_suffix("```"))
        .unwrap_or(text)
        .trim()
}

#[cfg(test)]
mod tests;
