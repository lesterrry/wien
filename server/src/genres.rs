//! Bundled guides: compile-time allowlist, no model-controlled filesystem access.
pub const SKILL: &str = include_str!("../../skill/skills/strudel-rag/SKILL.md");
pub const INDEX: &str = include_str!("../../skill/skills/strudel-rag/references/genres/README.md");
pub const NAMES: &[&str] = &[
    "ambient",
    "breakbeat",
    "deep-house",
    "downtempo",
    "drum-and-bass",
    "dubstep",
    "electro",
    "future-bass",
    "hardcore",
    "hardstyle",
    "house",
    "idm",
    "jungle",
    "psytrance",
    "synthwave",
    "tech-house",
    "techno",
    "trance",
    "trip-hop",
    "uk-garage",
];
pub fn get(name: &str) -> Option<&'static str> {
    match name {
        "ambient" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/ambient.md"
        )),
        "breakbeat" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/breakbeat.md"
        )),
        "deep-house" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/deep-house.md"
        )),
        "downtempo" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/downtempo.md"
        )),
        "drum-and-bass" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/drum-and-bass.md"
        )),
        "dubstep" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/dubstep.md"
        )),
        "electro" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/electro.md"
        )),
        "future-bass" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/future-bass.md"
        )),
        "hardcore" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/hardcore.md"
        )),
        "hardstyle" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/hardstyle.md"
        )),
        "house" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/house.md"
        )),
        "idm" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/idm.md"
        )),
        "jungle" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/jungle.md"
        )),
        "psytrance" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/psytrance.md"
        )),
        "synthwave" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/synthwave.md"
        )),
        "tech-house" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/tech-house.md"
        )),
        "techno" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/techno.md"
        )),
        "trance" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/trance.md"
        )),
        "trip-hop" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/trip-hop.md"
        )),
        "uk-garage" => Some(include_str!(
            "../../skill/skills/strudel-rag/references/genres/uk-garage.md"
        )),
        _ => None,
    }
}
