use super::SAMPLE_RATE;
use rustfft::{FftPlanner, num_complex::Complex};
use serde_json::{Value, json};

// These are deliberately spectral observations, not a claimed polyphonic transcription.
// RustFFT supplies the transform; Argon resolves fundamentals, harmonics and echoes.
pub(super) fn analyze(samples: &[f32]) -> Value {
    const SIZE: usize = 4096;
    const HOP: usize = 240; // 10 ms onset resolution
    let fft = FftPlanner::<f32>::new().plan_fft_forward(SIZE);
    let mut frame = vec![Complex::default(); SIZE];
    let mut scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
    let window: Vec<f32> = (0..SIZE)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / SIZE as f32).cos())
        .collect();
    let mut previous = vec![0.0f32; SIZE / 2];
    let mut fluxes = Vec::new();
    let mut spectra = Vec::new();
    let mut energies = Vec::new();
    for center in (0..samples.len()).step_by(HOP) {
        for i in 0..SIZE {
            let index = center as isize + i as isize - (SIZE / 2) as isize;
            frame[i] = Complex::new(
                if index >= 0 {
                    samples.get(index as usize).copied().unwrap_or(0.0) * window[i]
                } else {
                    0.0
                },
                0.0,
            );
        }
        fft.process_with_scratch(&mut frame, &mut scratch);
        let magnitude: Vec<f32> = frame[..SIZE / 2].iter().map(|v| v.norm()).collect();
        let flux: f32 = magnitude
            .iter()
            .zip(&previous)
            .map(|(a, b)| (a.ln_1p() - b.ln_1p()).max(0.0))
            .sum();
        fluxes.push(flux);
        previous = magnitude.clone();
        let block = &samples[center..(center + HOP).min(samples.len())];
        energies.push(block.iter().map(|x| x * x).sum::<f32>() / block.len() as f32);
        if center % (HOP * 10) == 0 {
            let mut peaks: Vec<_> = (13..427)
                .filter(|&i| magnitude[i] > magnitude[i - 1] && magnitude[i] >= magnitude[i + 1])
                .collect();
            peaks.sort_by(|&a, &b| magnitude[b].total_cmp(&magnitude[a]));
            let max = peaks.first().map_or(1.0, |&i| magnitude[i]).max(1e-8);
            let peaks: Vec<_> = peaks.into_iter().take(6).map(|i| {
                let offset = 0.5 * (magnitude[i-1] - magnitude[i+1]) / (magnitude[i-1] - 2.0 * magnitude[i] + magnitude[i+1]);
                let hz = (i as f32 + offset.clamp(-0.5,0.5)) * SAMPLE_RATE as f32 / SIZE as f32;
                let midi = (69.0 + 12.0 * (hz / 440.0).log2()).round() as i32;
                json!({"midi":midi,"hz":(hz*10.0).round()/10.0,"relative_strength":(magnitude[i]/max*100.0).round()/100.0})
            }).collect();
            spectra.push(json!({"time_s":center as f64/SAMPLE_RATE as f64,"peaks":peaks}));
        }
    }
    let smoothed: Vec<f32> = (0..fluxes.len())
        .map(|i| {
            let range = &fluxes[i.saturating_sub(2)..(i + 3).min(fluxes.len())];
            range.iter().sum::<f32>() / range.len() as f32
        })
        .collect();
    let max_flux = smoothed.iter().copied().fold(0.0f32, f32::max);
    let mut candidates: Vec<_> = (1..smoothed.len().saturating_sub(1))
        .filter(|&i| {
            smoothed[i] > max_flux * 0.12
                && smoothed[i] > smoothed[i - 1]
                && smoothed[i] >= smoothed[i + 1]
        })
        .collect();
    candidates.sort_by(|&a, &b| smoothed[b].total_cmp(&smoothed[a]));
    let mut attacks = Vec::<usize>::new();
    for candidate in candidates {
        if attacks.iter().all(|&a| a.abs_diff(candidate) >= 10) {
            attacks.push(candidate);
        }
    }
    attacks.sort_unstable();
    let times: Vec<f64> = attacks
        .iter()
        .map(|&i| i as f64 * HOP as f64 / SAMPLE_RATE as f64)
        .collect();
    let mut intervals: Vec<f64> = times
        .windows(2)
        .map(|p| p[1] - p[0])
        .filter(|&d| (0.15..=1.0).contains(&d))
        .collect();
    intervals.sort_by(f64::total_cmp);
    let interval = intervals.get(intervals.len() / 2).copied();
    let max_energy = energies.iter().copied().fold(0.0f32, f32::max);
    let first_signal = energies
        .iter()
        .position(|&e| e > (max_energy * 0.01).max(1e-8))
        .map(|i| i as f64 * 0.01);
    json!({"first_signal_s":first_signal,"attack_candidates_s":times,
        "median_attack_interval_s":interval,"tempo_caveat":"Intervals can be subdivisions, echoes or mixed parts; test half/double tempo by listening.",
        "spectral_frames":spectra})
}
