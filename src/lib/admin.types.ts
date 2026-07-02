export interface AdminConfig {
  ConfigSubscribtion: {
    URL: string;
    AutoUpdate: boolean;
    LastCheck: string;
  };
  ConfigFile: string;
  SiteConfig: {
    SiteName: string;
    Announcement: string;
    SearchDownstreamMaxPage: number;
    SiteInterfaceCacheTime: number;
    DoubanProxyType: string;
    DoubanProxy: string;
    DoubanImageProxyType: string;
    DoubanImageProxy: string;
    BangumiProxyType: string;
    BangumiProxy: string;
    BangumiImageProxyType: string;
    BangumiImageProxy: string;
    ServerHttpProxy: string;
    DanmuApiUrl: string;
    DanmuApiToken: string;
    DisableYellowFilter: boolean;
    FluidSearch: boolean;
  };
  DanmuApiConfig?: {
    enabled: boolean;                    // 是否启用弹幕API（默认启用）
    useCustomApi: boolean;               // 是否使用自定义API（false则使用默认API）
    customApiUrl: string;                // 自定义弹幕API地址
    customToken: string;                 // 自定义API Token
    timeout: number;                     // 请求超时时间（秒），默认30
  };
  UserConfig: {
    AutoCleanupInactiveUsers?: boolean; // 是否自动清理非活跃用户，默认 false
    InactiveUserDays?: number; // 非活跃用户保留天数，默认 7
    Users: {
      username: string;
      role: 'user' | 'admin' | 'owner';
      banned?: boolean;
      enabledApis?: string[]; // 优先级高于tags限制
      tags?: string[]; // 多 tags 取并集限制
      createdAt?: number; // 用户注册时间戳
    }[];
    Tags?: {
      name: string;
      enabledApis: string[];
    }[];
  };
  SourceConfig: {
    key: string;
    name: string;
    api: string;
    detail?: string;
    type?: 'vod' | 'shortdrama'; // 视频源类型：vod=普通视频，shortdrama=短剧
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
  CustomCategories: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
  LiveConfig?: {
    key: string;
    name: string;
    url: string;  // m3u 地址
    ua?: string;
    epg?: string; // 节目单
    from: 'config' | 'custom';
    channelNumber?: number;
    disabled?: boolean;
  }[];
  ShortDramaConfig?: {
    primaryApiUrl: string;
    alternativeApiUrl: string;
    enableAlternative: boolean;
  };
}

export interface AdminConfigResult {
  Role: 'owner' | 'admin';
  Config: AdminConfig;
}
