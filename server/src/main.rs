use std::{net::IpAddr, path::PathBuf, process::ExitCode};

use wien_server::{api, config::Config};

#[tokio::main]
async fn main() -> ExitCode {
    service_runtime::init_logging();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = %error, "HTTP server failed");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let host = std::env::var("WIEN_SERVER_HOST")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse::<IpAddr>()?;
    let port = std::env::var("WIEN_SERVER_PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse::<u16>()?;
    let config_path = std::env::var_os("WIEN_SERVER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("server/config.toml"));
    let config = Config::load(&config_path).map_err(|error| error.to_string())?;
    let provider = config.provider.build()?;
    let database = wien_server::database::connect().await?;
    let mut auth = wien_server::auth::Auth::new(database.clone()).await?;
    if let Some(turnstile) = wien_server::auth::turnstile::Turnstile::from_env()? {
        auth = auth.with_registration(std::sync::Arc::new(turnstile));
    }
    let _cleanup = wien_server::auth::start_cleanup(database.clone());
    let tools = std::sync::Arc::new(wien_server::assistant::tools::Tools(
        wien_server::rag::RagClient::from_env()?,
    ));
    let address = std::net::SocketAddr::new(host, port);
    tracing::info!(%address, "starting HTTP server");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                format!("Cannot start Wien: {address} is already in use.")
            } else {
                format!("Cannot bind Wien server to {address}: {error}")
            }
        })?;
    tracing::info!(address = %listener.local_addr()?, "HTTP server listening");
    axum::serve(
        listener,
        api::router_with_database(provider, config.generation, tools, Some(database))
            .merge(wien_server::auth::router(auth)),
    )
    .with_graceful_shutdown(service_runtime::shutdown_signal())
    .await?;
    Ok(())
}
