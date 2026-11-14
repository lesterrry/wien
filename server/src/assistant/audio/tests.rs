use super::*;
use crate::providers::{ModelOptions, ModelResponse};
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};

fn attachment(seconds: f32, rate: u32) -> AudioAttachment {
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 1,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..(seconds * rate as f32) as usize {
            let s = if i < rate as usize / 4 {
                0.0
            } else {
                (i as f32 * std::f32::consts::TAU * 440.0 / rate as f32).sin() * 12000.0
            };
            writer.write_sample(s as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    AudioAttachment {
        wav_base64: STANDARD.encode(bytes.into_inner()),
    }
}

#[test]
fn validates_actual_samples_instead_of_trusting_duration_metadata() {
    assert_eq!(attachment(10.0, 24000).samples().unwrap().len(), 240000);
    assert!(attachment(10.001, 24000).samples().is_none());
    assert!(attachment(0.05, 24000).samples().is_none());
    assert!(attachment(1.0, 48000).samples().is_none());
    assert!(
        AudioAttachment {
            wav_base64: "not audio".into()
        }
        .samples()
        .is_none()
    );
    let mut truncated = STANDARD.decode(attachment(1.0, 24000).wav_base64).unwrap();
    truncated.truncate(100);
    assert!(
        AudioAttachment {
            wav_base64: STANDARD.encode(truncated)
        }
        .samples()
        .is_none()
    );
}

#[test]
fn measures_silence_and_pitch_without_hardcoded_song_hints() {
    let samples = attachment(1.0, 24000).samples().unwrap();
    let hints = measurements::analyze(&samples);
    assert!((hints["first_signal_s"].as_f64().unwrap() - 0.25).abs() < 0.02);
    assert_eq!(hints["spectral_frames"][5]["peaks"][0]["midi"], 69);
    let silence = measurements::analyze(&vec![0.0; 24000]);
    assert!(silence["first_signal_s"].is_null());
    assert_eq!(silence["attack_candidates_s"], serde_json::json!([]));
}

struct Model {
    calls: AtomicUsize,
    fail_second: bool,
}
#[async_trait]
impl Provider for Model {
    async fn send(&self, _: &str, _: &ModelOptions) -> Result<ModelResponse, ProviderError> {
        unreachable!()
    }
    async fn audio(&self, prompt: &str, wav: &str) -> Result<String, ProviderError> {
        assert!(
            AudioAttachment {
                wav_base64: wav.into()
            }
            .samples()
            .is_some()
        );
        let stage = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(prompt.contains("test request"));
        if stage == 0 {
            return Ok(r#"{"bpm":120,"notes":[],"code":"note('a4')"}"#.into());
        }
        assert_eq!(stage, 1);
        assert!(prompt.contains("attack_candidates_s"));
        assert!(prompt.contains("Previous reconstruction"));
        if self.fail_second {
            return Err(ProviderError::Timeout);
        }
        Ok(r#"{"message":"Ready","code":"note('a4').s('sine')"}"#.into())
    }
}

#[tokio::test]
async fn both_passes_use_audio_and_refinement_is_required() {
    for fail in [false, true] {
        let model = Model {
            calls: AtomicUsize::new(0),
            fail_second: fail,
        };
        let request:AssistRequest = serde_json::from_value(serde_json::json!({"prompt":"test request","file":{"path":"test.strudel","content":"","cursor":{"anchor":0,"head":0}},"audio":{"wav_base64":attachment(1.0,24000).wav_base64}})).unwrap();
        let result = recreate(&model, &request, request.audio.as_ref().unwrap()).await;
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        if fail {
            assert_eq!(result.unwrap_err(), ProviderError::Timeout);
        } else {
            assert_eq!(
                result.unwrap().code.as_deref(),
                Some("note('a4').s('sine')")
            );
        }
    }
}
