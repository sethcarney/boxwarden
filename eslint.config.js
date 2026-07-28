import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat config, matching `eslint.useFlatConfig` in .devcontainer/devcontainer.json.
 *
 * The config mirrors the two-project TypeScript split: main and preload get
 * Node globals and no DOM, the renderer gets the reverse. That is not
 * cosmetic — it is what makes a stray `document` in main-process code an error
 * rather than something that typechecks and then crashes at runtime.
 *
 * Type-aware rules are on. They cost a slower lint, and they buy the only
 * rules that matter for an app that is mostly async I/O: no-floating-promises
 * and no-misused-promises. `void promise` is the intended way to say "fire and
 * forget on purpose" and appears throughout main/index.ts.
 *
 * `prettier` goes last so formatting rules are disabled rather than fought.
 */
export default tseslint.config(
  {
    ignores: ['out/', 'dist/', 'release/', 'coverage/', 'node_modules/'],
  },

  js.configs.recommended,

  // Type-aware linting applies to TypeScript only. Applying it to plain .js
  // and .mjs makes the project service fail to resolve them to a tsconfig,
  // which surfaces as a parse error rather than anything useful.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // Resolves each file to whichever tsconfig covers it, so the renderer
        // is checked against tsconfig.web.json and main against
        // tsconfig.node.json without listing them here.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // verbatimModuleSyntax is on, so type-only imports must say so.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // An unawaited promise in an IPC handler silently swallows the failure.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // The codebase leans on exhaustive switches over the domain's unions
      // (DevContainerRuntime, EndpointFailure). This is what catches a new arm
      // that nobody handled. `considerDefaultExhaustiveForUnions` accepts a
      // `default` as covering the rest — several switches here dispatch on a
      // possibly-undefined Docker field and deliberately fall back.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `${count} minutes ago` is not a bug. The rule's real target is
      // stringifying objects, which stays on.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // `() => void refresh()` is the deliberate "fire and forget" idiom that
      // no-floating-promises asks for; without this exemption the two rules
      // contradict each other.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

      // `process.env['FOO']` is bracket-indexed on purpose: it is an index
      // signature, and writing it as a property implies a field that exists.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
    },
  },

  // ---- main process and preload: Node, no DOM ----
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '*.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  // ---- renderer: browser, no Node ----
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // ---- tests ----
  {
    files: ['src/**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Fixtures deliberately construct malformed inputs — an unparseable
      // label, a state Docker has never emitted — and casting to build them is
      // the point of those tests.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  prettier,
);
