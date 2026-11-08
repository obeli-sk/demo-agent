{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    obelisk = {
      url = "github:obeli-sk/obelisk/v0.43.0-rc.17";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        flake-utils.follows = "flake-utils";
      };
    };
  };
  outputs = { self, nixpkgs, flake-utils, obelisk }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          commonDeps = with pkgs; [
            just
            jq
            nodejs # unit tests (node --test)
            gh # scripts/sync-branch-protection.sh
            yq-go # scripts/sync-branch-protection.sh
          ];
        in
        {
          # No-Obelisk shell for CI unit tests only.
          devShells.noObelisk = pkgs.mkShell {
            nativeBuildInputs = commonDeps;
          };
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = commonDeps ++ [ obelisk.packages.${system}.default ];
          };
        }
      );
}
