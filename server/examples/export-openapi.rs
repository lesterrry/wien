use std::io::{self, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    serde_json::to_writer_pretty(&mut output, &wien_server::api::openapi())?;
    writeln!(output)?;
    Ok(())
}
