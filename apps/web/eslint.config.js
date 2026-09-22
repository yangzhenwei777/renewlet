import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      // 产物/生成文件不参与 lint（避免把编译后的内容当源码检查）
      "out",
      "coverage",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 现有 shadcn/ui 存在“导出组件 + 导出工具函数”的模式，这里不把它视为迁移阻断。
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // 本项目存在“从 localStorage/远端数据同步到 state”的场景，这类同步是合理且必要的。
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "sonner",
              message: "请从 @/components/ui/sonner 使用全站唯一通知出口。",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='toast'][callee.property.name='success'] > ObjectExpression.arguments > Property[key.name='description']",
          message: "成功 Toast 必须是单行结果，不得使用 description。",
        },
      ],
    },
  },
  {
    files: ["src/components/ui/sonner.tsx"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
