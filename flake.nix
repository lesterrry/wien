{
  description = "Node.js and pnpm development environment (FHS for Electron)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSupportedSystem = f: nixpkgs.lib.genAttrs supportedSystems (system: f {
        pkgs = import nixpkgs { inherit system; };
      });
    in
    {
      devShells = forEachSupportedSystem ({ pkgs }:
        let
          commonPackages = with pkgs; [
            nodejs_22
            pnpm
            just
          ];

          baseShell = pkgs.mkShell {
            packages = commonPackages;
            npm_config_manage_package_manager_versions = "false";
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        in
        {
          default = if pkgs.stdenv.hostPlatform.isLinux then
            (pkgs.buildFHSEnv {
              name = "electron-dev-env";
              targetPkgs = pkgs: 
                commonPackages ++ (with pkgs; [
                  bashInteractive
                  nspr
                  nss
                  glib.out      
                  dbus.lib      
                  atk
                  at-spi2-atk
                  at-spi2-core
                  cups.lib
                  libdrm
                  expat
                  libxkbcommon
                  libgbm 
                  alsa-lib
                  pango.out
                  cairo
                  libGL
                  gtk3
                  systemd
                  libpulseaudio

                  libx11
                  libxcomposite
                  libxdamage
                  libxext
                  libxfixes
                  libxrandr
                  libxcb
                  libxcursor
                  libxi
                  libxtst
                  libxshmfence
                ]);
              
              profile = ''
                export SHELL="${pkgs.bashInteractive}/bin/bash -i"
              '';
              runScript = "bash";
            }).env
          else
            baseShell;
        });
    };
}