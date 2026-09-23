// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * §8 "no `number` for currency (lint rule)": flag `number` type annotations on identifiers and
 * properties whose names look like money. Money crosses boundaries as decimal strings and is
 * computed as `Decimal` (ADR-0003). Quantities, counts, percentages-as-config and durations are
 * not matched.
 */
const MONEY_NAME =
  /(gbp|price|cost|fee|fees|duty|vat|premium|landed|customs(value)?|amount|money|subtotal|total)(?!s?(count|qty|quantity|days|ms|pct|percent|rate))/i;

/** @type {import('eslint').Rule.RuleModule} */
const noNumberMoney = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `number` for money-like identifiers; use Decimal or decimal strings.',
    },
    schema: [],
    messages: {
      noNumber:
        'Money must not be a `number` ("{{name}}"). Use `Decimal` in code and decimal strings at boundaries (ADR-0003).',
    },
  },
  create(context) {
    /** @param {import('estree').Node & { typeAnnotation?: any }} node @param {string} name */
    const check = (node, name) => {
      const ann = node.typeAnnotation?.typeAnnotation;
      if (ann && ann.type === 'TSNumberKeyword' && MONEY_NAME.test(name)) {
        context.report({ node, messageId: 'noNumber', data: { name } });
      }
    };
    return {
      Identifier(node) {
        check(/** @type {any} */ (node), node.name);
      },
      TSPropertySignature(node) {
        const key = /** @type {any} */ (node).key;
        if (key?.type === 'Identifier') check(/** @type {any} */ (node), key.name);
      },
      PropertyDefinition(node) {
        const key = /** @type {any} */ (node).key;
        if (key?.type === 'Identifier') check(/** @type {any} */ (node), key.name);
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '**/dist/**',
      '**/build/**',
      '**/.react-router/**',
      '**/generated/**',
      '**/node_modules/**',
      'infra/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { harbour: { rules: { 'no-number-money': noNumberMoney } } },
    rules: {
      'harbour/no-number-money': 'error',
      // Interface implementations (in-memory stores, fakes) are legitimately async without await.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // React Router loaders/actions throw `redirect()` (a Response) and `data()` to short-circuit;
      // those two are allowed, every other thrown value must still be an Error.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'lib', name: 'Response' },
            { from: 'package', package: 'react-router', name: 'DataWithResponseInit' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (§7.5). Encode via React.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat loses precision. Use Decimal (ADR-0003).',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/scripts/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  prettier,
);
