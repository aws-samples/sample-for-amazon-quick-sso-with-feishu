#!/usr/bin/env node
import 'source-map-support/register';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FeishuQuickSsoStack } from './stacks/feishu-quick-sso-stack';
import {
  FEISHU_CN_ENDPOINTS,
  LARK_ENDPOINTS,
  FeishuEmailClaim,
  FeishuQuickSsoConfig,
  FeishuSubjectClaim,
  ProjectName,
  createStackName,
} from './common/config';

const region = process.env.CDK_DEFAULT_REGION || 'us-east-1';

const app = new App();

// cdk-nag: fail synth on AWS Solutions rule violations (acknowledged rules are
// declared inline next to the constructs they concern).
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

// Required context: -c feishuAppId=cli_xxxx
const feishuAppId = app.node.tryGetContext('feishuAppId') as string | undefined;
if (!feishuAppId) {
  throw new Error('Missing required context: -c feishuAppId=<your Feishu App ID>');
}

const retainResources = app.node.tryGetContext('retain') === 'true';
const allowedCidrs = app.node.tryGetContext('allowedCidrs') as string[] | undefined;
const quickRegion = (app.node.tryGetContext('quickRegion') as string | undefined) || region;
const useLark = app.node.tryGetContext('lark') === 'true';
const subjectClaim =
  (app.node.tryGetContext('subjectClaim') as FeishuSubjectClaim | undefined) ||
  FeishuSubjectClaim.UNION_ID;
const emailClaim =
  (app.node.tryGetContext('emailClaim') as FeishuEmailClaim | undefined) ||
  FeishuEmailClaim.ENTERPRISE;

const config: FeishuQuickSsoConfig = {
  projectName: ProjectName.FEISHU_QUICK_SSO,
  retainResources,
  feishuAppId,
  feishuSubjectClaim: subjectClaim,
  feishuEmailClaim: emailClaim,
  endpoints: useLark ? LARK_ENDPOINTS : FEISHU_CN_ENDPOINTS,
  quickRegion,
  ...(allowedCidrs && { allowedCidrs }),
};

new FeishuQuickSsoStack(app, createStackName(config.projectName, 'Main'), {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});

app.synth();
