# Contributing to schflow

贡献欢迎。开工前请先读 [docs/design.md](./docs/design.md)（v1.0 设计定稿）与 [docs/adr/](./adr/)（31 条实战决策归档——大部分「为什么不这样做」的答案在里面）。

- **提示词/技能层**（`skills/`）：改 markdown 即可，无需代码——这是最常见也最安全的贡献面；
- **确定性层**（`core/`）：TypeScript，Node ≥20；改动须过三平台 CI（win/mac/linux）；
- **提交信息**：中文 conventional commit（`feat:/fix:/docs:/refactor:` …）；
- **纪律**：一切状态经唯一出口写入（详见 design.md §17.4）；不要在提示词文件里硬编码私有环境信息（见 ADR 匿名化口径）。

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
