import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import mvvm from 'eslint-plugin-mvvm';
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
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '*.config.ts', 'scripts/**/*.{mjs,ts}'],
    languageOptions: { globals: globals.node },
  },

  // ---- renderer: browser, no Node ----
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // ---- MVVM layer boundaries ----
  //
  // eslint-plugin-mvvm turns the layering rule in CLAUDE.md from prose the
  // reviewer has to remember into an error the linter raises. It covers the
  // three layers it can classify — `src/models` (Model),
  // `src/renderer/viewmodels` (ViewModel), and the `.tsx` under `src/renderer`
  // (View) — and enforces the one-way import direction between them.
  //
  // `src/main` and `src/preload` are deliberately out of scope: they are the
  // impure shells behind the IPC boundary, not an MVVM layer. The plugin would
  // classify them `unknown` and no-op anyway, so listing them would only
  // suggest a boundary that is not being checked.
  {
    files: ['src/models/**/*.ts', 'src/renderer/**/*.{ts,tsx}'],
    extends: [mvvm.configs.recommended],
    settings: {
      mvvm: {
        // Spelled out rather than left to the plugin's generic conventions, so
        // classification tracks this repo's actual layout. The defaults also
        // read `services/`, `api/`, `stores/` and `domain/` as Model — none of
        // those exist here, and a future `src/main/services/` would silently
        // start being linted as a Model layer it is not.
        modelPatterns: ['/src/models/'],
        // The hooks, plus the pure `.ts` modules sitting directly under
        // src/renderer — presenters, format, grouping, view. CLAUDE.md's
        // diagram already draws presenters.ts inside the ViewModel box, and
        // the others fill the same role: derivations a View binds to. Naming
        // them makes the direction checked rather than merely unenforced —
        // `unknown` is exempt from this rule, so leaving them out would mean
        // presenters.ts could import a component and nothing would say so.
        // Components live in subdirectories and are .tsx, so neither the
        // extension nor the shape of this pattern can catch them.
        viewModelPatterns: ['/src/renderer/viewmodels/', '/src/renderer/[^/]*\\.ts$'],
        viewDirPatterns: ['/src/renderer/views/', '/src/renderer/components/'],
        // Directory hints are matched relative to this, so the patterns above
        // cannot be satisfied by an ancestor directory outside the checkout.
        root: import.meta.dirname,
      },
    },
    rules: {
      // `strict` rather than the preset's `warn-business`. That mode only
      // fires when state sits next to a `fetch`/axios/TanStack call, and this
      // app reaches Docker over `window.boxwarden`, so it would never fire at
      // all. Strict enforces what CLAUDE.md actually says — a View decides
      // nothing — and it is what catches a component growing a private copy of
      // state a ViewModel already owns.
      'mvvm/no-state-in-view': ['error', { mode: 'strict' }],
    },
  },

  // The plugin's `no-api-in-view` knows fetch/axios/TanStack, none of which
  // this app uses: the bridge is reached through `getApi()` in
  // `src/renderer/api.ts`. This is that rule expressed in this app's terms —
  // a View must take its data from a ViewModel prop, never open the bridge
  // itself.
  {
    files: ['src/renderer/**/*.tsx'],
    ignores: ['src/renderer/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api.js', '**/api.ts'],
              message:
                'Views must not reach the preload bridge. Take the data from a ViewModel prop instead — getApi() belongs in src/renderer/viewmodels/.',
            },
          ],
        },
      ],
    },
  },

  // The other half of the import direction, which the plugin cannot see here.
  //
  // `enforce-layer-boundaries` classifies a View by file extension, and it
  // resolves a relative specifier by looking for it on disk. This project has
  // `verbatimModuleSyntax` on and writes every relative import with a `.js`
  // suffix (`./components/StatusDot.js`), which resolves to nothing — the file
  // on disk is `.tsx` — and the plugin does not apply TypeScript's `.js` →
  // `.tsx` rewrite before giving up. Model and ViewModel survive that because
  // their patterns are directory-based; View does not, so `modelImportsView`
  // and `viewModelImportsView` never fire in this repo. These two guards say
  // the same thing by path instead of by layer.
  {
    files: ['src/models/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer/**', '**/main/**', '**/preload/**'],
              message:
                'src/models is pure and imports nothing outside itself. Anything that touches Electron, the DOM, or the filesystem belongs in a shell under src/main.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/viewmodels/**/*.ts', 'src/renderer/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/components/**', '**/views/**'],
              message:
                'A ViewModel renders nothing. Return the data a View needs and let it do the rendering — importing a component here is what makes this layer untestable without a DOM.',
            },
          ],
        },
      ],
    },
  },

  // ---- tests ----
  {
    files: ['src/**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // A `.test.tsx` is not a View — it is the harness that mounts one, and
      // building a fixture means calling the Model's own brand constructors
      // (`asContainerId`, `asProjectId`). That is the fixture doing its job,
      // not a layer leak, and `src/renderer/test-fixtures.ts` exists precisely
      // to construct those values.
      'mvvm/enforce-layer-boundaries': 'off',

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
