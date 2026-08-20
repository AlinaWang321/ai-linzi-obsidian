import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  {
    ignores: ['main.js', 'node_modules/**', 'release/**'],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 删除行为必须尊重用户的系统废纸篓 / Obsidian 回收站设置。
      'obsidianmd/prefer-file-manager-trash-file': 'error',
    },
  },
])
