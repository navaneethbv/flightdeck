import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['src/core/executables.ts', 'src/playbooks/library.ts'],
    plugins: { security },
    rules: { 'security/detect-non-literal-fs-filename': 'error' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
