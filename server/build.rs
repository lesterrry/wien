fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut prost = prost_build::Config::new();
    prost.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure()
        .type_attribute(".", "#[derive(serde::Serialize)]")
        .compile_with_config(
            prost,
            &["../skill/proto/strudel/rag/v1/rag.proto"],
            &["../skill/proto"],
        )?;
    println!("cargo:rerun-if-changed=../skill/proto/strudel/rag/v1/rag.proto");
    Ok(())
}
