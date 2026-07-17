import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import {
  RestApi,
  LambdaIntegration,
  AccessLogFormat,
  LogGroupLogDestination,
} from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IUserPool } from 'aws-cdk-lib/aws-cognito';
import { Role, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import {
  PolicyDocument,
  PolicyStatement as ResourcePolicyStatement,
  AnyPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { join } from 'path';
import {
  ProjectName,
  QuickUserRole,
  ResourceName,
  acknowledgeRule,
  createConstructId,
  createResourceName,
  isProRole,
  toQuickApiRole,
} from '../common/config';

export interface WebPortalProps {
  readonly projectName: ProjectName;
  /** Deterministic Cognito hosted-UI domain (account+region derived, no token). */
  readonly cognitoDomain: string;
  readonly federationRole: Role;
  readonly quickRegion: string;
  /** First-login role. Pro roles make the portal pre-register users via RegisterUser. */
  readonly quickUserRole: QuickUserRole;
  readonly allowedCidrs?: string[];
}

/**
 * The Web sign-in portal: an API Gateway + Lambda that runs the OIDC code flow
 * against the shared Cognito pool, then trades the id_token's email for a Quick
 * Web console session via sts:AssumeRole + the AWS federation endpoint.
 */
export class WebPortal extends Construct {
  public readonly api: RestApi;
  public readonly portalUrl: string;
  /** The portal Lambda's execution role ARN — the only principal that may assume the Quick role. */
  public readonly lambdaRoleArn: string;

  private readonly fn: LambdaFunction;

  constructor(scope: Construct, id: string, props: WebPortalProps) {
    super(scope, id);

    const { projectName, cognitoDomain, federationRole, quickRegion, quickUserRole, allowedCidrs } =
      props;
    const { account, partition, region } = Stack.of(this);

    const policy = allowedCidrs ? this.createResourcePolicy(allowedCidrs) : undefined;

    const accessLogs = new LogGroup(this, createConstructId('ApiAccessLogs'), {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.api = new RestApi(this, createConstructId('Api'), {
      restApiName: createResourceName(projectName, ResourceName.WEB_PORTAL_API),
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
      },
      ...(policy && { policy }),
    });

    // Derive from restApiId to avoid the self-referential deployment-stage cycle.
    this.portalUrl = `https://${this.api.restApiId}.execute-api.${region}.amazonaws.com/prod`;

    this.fn = new LambdaFunction(this, createConstructId('Function'), {
      functionName: createResourceName(projectName, ResourceName.WEB_PORTAL_FUNCTION),
      runtime: Runtime.PYTHON_3_14,
      handler: 'handler.handler',
      code: Code.fromAsset(join(__dirname, '..', '..', 'lambda', 'web_portal')),
      timeout: Duration.seconds(15),
      environment: {
        COGNITO_DOMAIN: cognitoDomain,
        FEDERATION_ROLE_ARN: federationRole.roleArn,
        QUICK_REGION: quickRegion,
        PORTAL_URL: this.portalUrl,
        // COGNITO_CLIENT_ID + COGNITO_USER_POOL_ID injected via setWebClient once
        // the pool/client exist (breaks the portal<->pool construction cycle).
      },
    });
    this.lambdaRoleArn = this.fn.role!.roleArn;

    // The portal Lambda must be allowed to assume (and tag) the Quick role.
    this.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [federationRole.roleArn],
      }),
    );

    // Pro roles have no IAM self-provision action, so the portal pre-registers
    // first-time users via the RegisterUser API (which supports *_PRO) right
    // before the federation sign-in. Scoped to registrations that bind exactly
    // our federation role via the quicksight:IamArn condition key.
    if (isProRole(quickUserRole)) {
      this.fn.addEnvironment('QUICK_NEW_USER_ROLE', toQuickApiRole(quickUserRole));
      this.fn.addEnvironment('QUICK_ACCOUNT_ID', account);
      this.fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['quicksight:RegisterUser'],
          resources: [`arn:${partition}:quicksight:*:${account}:user/*`],
          conditions: {
            StringEquals: { 'quicksight:IamArn': federationRole.roleArn },
          },
        }),
      );
      acknowledgeRule(
        this,
        `AwsSolutions-IAM5[Resource::arn:${partition}:quicksight:*:${account}:user/*]`,
        'RegisterUser creates user records whose names are derived from user emails, ' +
          'unknowable at deploy time; the grant is bounded to this account and to ' +
          'registrations binding exactly the federation role via quicksight:IamArn.',
      );
    }

    const integration = new LambdaIntegration(this.fn);
    this.api.root.addResource('login').addMethod('GET', integration);
    this.api.root.addResource('callback').addMethod('GET', integration);

    // Fold routes into the deployment logical id so route changes repoint the
    // stage (avoids stale-snapshot 403s). See FeishuAdapter for the full rationale.
    this.api.latestDeployment?.addToLogicalId(['login', 'callback']);

    this.acknowledgeNagRules();
  }

  /** cdk-nag acknowledgements — each documents why the finding is intentional here. */
  private acknowledgeNagRules(): void {
    const acknowledge = (id: string, reason: string): void =>
      acknowledgeRule(this, id, reason);

    acknowledge(
      'AwsSolutions-COG4',
      '/login and /callback are the public entry points of the sign-in flow — they run ' +
        'BEFORE a Cognito session exists, so they cannot require a Cognito authorizer. ' +
        'Authentication is the OIDC code flow they implement.',
    );
    acknowledge(
      'AwsSolutions-APIG4',
      'Public sign-in endpoints; authorization is the OIDC authorization-code flow itself.',
    );
    acknowledge(
      'AwsSolutions-APIG2',
      'Request validation happens in the Lambda handler (missing code -> 400).',
    );
    acknowledge(
      'AwsSolutions-APIG3',
      'WAF is an optional hardening step for this sample; source IPs can be restricted ' +
        'with -c allowedCidrs (resource policy), as documented in the README.',
    );
    acknowledge(
      'AwsSolutions-APIG6',
      'Per-method CloudWatch execution logging would require the account-level API ' +
        'Gateway CloudWatch role; structured access logging is enabled on the stage instead.',
    );
    acknowledge(
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AWSLambdaBasicExecutionRole only grants CloudWatch Logs write access — the ' +
        'AWS-recommended baseline for Lambda execution roles.',
    );
  }

  public get loginUrl(): string {
    return `${this.portalUrl}/login`;
  }

  public get callbackUrl(): string {
    return `${this.portalUrl}/callback`;
  }

  /**
   * Inject the Cognito Web client id + pool after they exist (breaks the cycle), and
   * grant the Lambda permission to read the confidential client's secret at runtime.
   */
  public setWebClient(clientId: string, userPool: IUserPool): void {
    this.fn.addEnvironment('COGNITO_CLIENT_ID', clientId);
    this.fn.addEnvironment('COGNITO_USER_POOL_ID', userPool.userPoolId);
    this.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [userPool.userPoolArn],
      }),
    );
  }

  private createResourcePolicy(allowedCidrs: string[]): PolicyDocument {
    return new PolicyDocument({
      statements: [
        new ResourcePolicyStatement({
          effect: Effect.ALLOW,
          principals: [new AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*/*/*'],
        }),
        new ResourcePolicyStatement({
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*/*/*'],
          conditions: { NotIpAddress: { 'aws:SourceIp': allowedCidrs } },
        }),
      ],
    });
  }
}
