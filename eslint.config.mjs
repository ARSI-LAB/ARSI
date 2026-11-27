import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const doubleAssertion = {
  selector:
    ':matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion).expression',
  message:
    'Validate or narrow the original value before using the target type.',
};

const directEffect =
  'Move the external subscription or DOM synchronization into a primitive in web/hooks/, or update state in the event that changes it.';

export default [
  {
    files: ['src/**/*.ts', 'web/**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-empty': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      'no-restricted-syntax': ['error', doubleAssertion],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    ignores: ['web/hooks/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        doubleAssertion,
        {
          selector:
            ':matches(ImportDeclaration[source.value="react"] > ImportSpecifier[imported.name="useEffect"], ExportNamedDeclaration[source.value="react"] > ExportSpecifier[local.name="useEffect"])',
          message: directEffect,
        },
        {
          selector:
            ':matches(MemberExpression[computed=false][property.name="useEffect"], MemberExpression[computed=true][property.value="useEffect"], ObjectPattern > Property[key.name="useEffect"], ObjectPattern > Property[key.value="useEffect"])',
          message: directEffect,
        },
      ],
    },
  },
];
