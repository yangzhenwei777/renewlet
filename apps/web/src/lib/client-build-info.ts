declare const __RENEWLET_CLIENT_BUILD_VERSION__: string;

// 构建版本只负责 badge 首屏兜底；权限、更新状态和上游排障信息仍以后端版本 API 为准。
export const clientBuildVersion = __RENEWLET_CLIENT_BUILD_VERSION__;
