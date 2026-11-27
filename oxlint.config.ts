import gdp from "@gdp-ts/core/lint/oxlint";

const preset = gdp({
  strict: true,
  allowAssertions: ["src/**/*.test.ts", "test/**"],
});

const shapeless =
  "Shapeless: says 'some object' while telling readers nothing. Name the domain type, or take `unknown` and decode where you read it.";

export default {
  jsPlugins: [
    ...preset.jsPlugins,
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "landmines-testing", specifier: "@interfere/landmines/testing" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",
    "typescript/no-restricted-types": ["error", { types: { "{}": shapeless, object: shapeless, Object: shapeless } }],
    "landmines-testing/no-fixed-sleep": "error",
    "landmines-testing/no-flake-masking": "error",
    "landmines-testing/no-test-doubles": "error",
    "landmines-testing/no-unsignaled-poll": "error",
    "landmines-testing/strict-msw": "error",
  },
  overrides: [
    ...preset.overrides,
    {
      files: ["src/**/*.test.ts", "test/**"],
      rules: {
        "anti-slop/no-known-value-widening": "off",
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-returns": "off",
        "typescript/no-restricted-types": "off",
      },
    },
  ],
};
