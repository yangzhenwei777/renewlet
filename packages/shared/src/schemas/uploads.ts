// 上传入口已彻底收敛到 media schema；保留这个 re-export 只为旧导入路径提供同一编译期契约，不定义第二套形状。
export { uploadKindSchema, type UploadKind } from "./media";
