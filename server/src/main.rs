use std::{net::Ipv4Addr, path::PathBuf};

use wien_server::{api, config::Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("WIEN_SERVER_PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse::<u16>()?;
    let config_path = std::env::var_os("WIEN_SERVER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("server/config.toml"));
    let config = Config::load(&config_path).map_err(|error| error.to_string())?;
    let provider = config.provider.build()?;
    let address = (Ipv4Addr::LOCALHOST, port);
    println!("Starting Wien server on http://127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                format!("Cannot start Wien: 127.0.0.1:{port} is already in use.")
            } else {
                format!("Cannot bind Wien server to 127.0.0.1:{port}: {error}")
            }
        })?;
    println!("Wien server: http://{}", listener.local_addr()?);
    println!("API docs: http://{}/docs/", listener.local_addr()?);
    axum::serve(listener, api::router(provider, config.assistant))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let interrupt = async {
        tokio::signal::ctrl_c().await.ok();
    };

    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    tokio::select! { _ = interrupt => {}, _ = terminate => {} }
}
