{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          git
          nodejs_22
          eslint
          prettier
          typescript
          typescript-language-server
        ];

        shellHook = ''
          echo "Tactical shooter dev shell"
          echo "  npm install        install workspace dependencies"
          echo "  npm run dev        run server and Phaser client"
          echo "  npm run typecheck  typecheck all workspaces"
          echo "  npm test           run unit/integration tests"
        '';
      };
    };
}
