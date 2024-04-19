export const pkg = {
    name: "detsys-ts",
    version: "1.0.0",
    description: "TypeScript goodies for DetSys projects",
    main: "./dist/main.js",
    types: "./dist/main.d.ts",
    type: "module",
    scripts: {
        build: "tsc",
        "check-fmt": "prettier --check .",
        format: "prettier --write .",
        lint: "eslint src/**/*.ts",
        prebuild: "echo 'export const pkg =' > src/package.ts; cat package.json >> ./src/package.ts && prettier --write ./src/package.ts && eslint --fix ./src/package.ts",
        docs: "pnpm run prebuild && typedoc src/main.ts",
        all: "pnpm run prebuild && pnpm run format && pnpm run lint && pnpm run build",
    },
    repository: {
        type: "git",
        url: "git+https://github.com/DeterminateSystems/detsys-ts.git",
    },
    keywords: [],
    author: "",
    license: "MIT",
    bugs: {
        url: "https://github.com/DeterminateSystems/detsys-ts/issues",
    },
    homepage: "https://github.com/DeterminateSystems/detsys-ts#readme",
    dependencies: {
        "@actions/cache": "^3.2.4",
        "@actions/core": "^1.10.1",
        got: "^14.2.1",
    },
    devDependencies: {
        "@trivago/prettier-plugin-sort-imports": "^4.3.0",
        "@types/node": "^20.12.7",
        "@typescript-eslint/eslint-plugin": "^7.6.0",
        eslint: "^8.57.0",
        "eslint-import-resolver-typescript": "^3.6.1",
        "eslint-plugin-github": "^4.10.2",
        "eslint-plugin-import": "^2.29.1",
        "eslint-plugin-prettier": "^5.1.3",
        prettier: "^3.2.5",
        typedoc: "^0.25.13",
        typescript: "^5.4.5",
    },
};
