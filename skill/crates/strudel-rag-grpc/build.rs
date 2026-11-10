fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut prost = prost_build::Config::new();
    prost.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure()
        .file_descriptor_set_path(
            std::path::PathBuf::from(std::env::var("OUT_DIR")?).join("rag_descriptor.bin"),
        )
        .compile_with_config(
            prost,
            &["../../proto/strudel/rag/v1/rag.proto"],
            &["../../proto"],
        )?;
    println!("cargo:rerun-if-changed=../../proto/strudel/rag/v1/rag.proto");
    Ok(())
}
