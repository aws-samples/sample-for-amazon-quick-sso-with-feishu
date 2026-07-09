import { RemovalPolicy } from 'aws-cdk-lib';

export enum ProjectName {
  FEISHU_QUICK_SSO = 'FeishuQuickSso',
}

export enum ResourceName {
  USER_POOL = 'UserPool',
  DESKTOP_CLIENT = 'DesktopClient',
  WEB_CLIENT = 'WebClient',
  FEISHU_ADAPTER_API = 'FeishuAdapter',
  FEISHU_ADAPTER_FUNCTION = 'FeishuAdapterFunction',
  FEISHU_SIGNING_KEY = 'FeishuAdapterSigningKey',
  WEB_PORTAL_API = 'WebPortal',
  WEB_PORTAL_FUNCTION = 'WebPortalFunction',
  FEDERATION_ROLE = 'QuickWebFederationRole',
}

export enum CognitoDomainPrefix {
  DEFAULT = 'feishu-quick-sso',
}

/** Feishu open-platform endpoints. Domestic (feishu.cn) by default; override for Lark. */
export interface FeishuEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly userInfo: string;
}

export const FEISHU_CN_ENDPOINTS: FeishuEndpoints = {
  authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  token: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  userInfo: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
};

export const LARK_ENDPOINTS: FeishuEndpoints = {
  authorize: 'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
  token: 'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
  userInfo: 'https://open.larksuite.com/open-apis/authen/v1/user_info',
};

export interface FeishuQuickSsoConfig {
  readonly projectName: ProjectName;
  readonly retainResources: boolean;
  /** Feishu self-built app credential (App ID). App Secret is stored in Secrets Manager post-deploy. */
  readonly feishuAppId: string;
  /** Which Feishu subject id becomes the OIDC `sub`. See docs for trade-offs. */
  readonly feishuSubjectClaim: FeishuSubjectClaim;
  /** Which Feishu mailbox field(s) map to the email claim Quick matches users on. */
  readonly feishuEmailClaim: FeishuEmailClaim;
  readonly endpoints: FeishuEndpoints;
  /** AWS partition/region hosting Amazon Quick, used to build the Web sign-in URL. */
  readonly quickRegion: string;
  readonly allowedCidrs?: string[];
}

export enum FeishuSubjectClaim {
  /** Stable across all apps in the tenant. Recommended so identity survives app changes. */
  UNION_ID = 'union_id',
  /** Unique only within this Feishu app. */
  OPEN_ID = 'open_id',
}

/**
 * Which Feishu mailbox field maps to the OIDC `email` claim. Feishu returns two:
 * `enterprise_email` (企业邮箱, admin-assigned) and `email` (工作邮箱, work email).
 * Quick matches users on this value, so it must equal the Quick user's email.
 */
export enum FeishuEmailClaim {
  /** Prefer 企业邮箱, fall back to 工作邮箱. Default. */
  ENTERPRISE = 'enterprise',
  /** Prefer 工作邮箱, fall back to 企业邮箱. */
  WORK = 'work',
  /** Use 企业邮箱 only; fail if absent. */
  ENTERPRISE_ONLY = 'enterprise_only',
  /** Use 工作邮箱 only; fail if absent. */
  WORK_ONLY = 'work_only',
}

export const createResourceName = (
  projectName: ProjectName,
  resourceName: ResourceName,
): string => `${projectName}${resourceName}`;

export const createDomainPrefix = (
  domainPrefix: CognitoDomainPrefix,
  account: string,
  region: string,
): string => `${domainPrefix}-${account}-${region}`;

export const createConstructId = (resourceName: string): string =>
  resourceName.charAt(0).toUpperCase() + resourceName.slice(1);

export const createStackName = (
  projectName: ProjectName,
  stackName: string,
): string => {
  const pascal = stackName.charAt(0).toUpperCase() + stackName.slice(1);
  return `${projectName}${pascal}Stack`;
};

export const getRemovalPolicy = (retain: boolean): RemovalPolicy =>
  retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
