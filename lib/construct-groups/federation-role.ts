import { Duration, Stack } from 'aws-cdk-lib';
import {
  Role,
  CfnRole,
  PolicyStatement,
  Effect,
  ArnPrincipal,
  PolicyDocument,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  ProjectName,
  QuickUserRole,
  ResourceName,
  acknowledgeRule,
  createConstructId,
  createResourceName,
  toBaseRole,
} from '../common/config';

export interface FederationRoleProps {
  readonly projectName: ProjectName;
  /** Quick role first-time users self-provision as; drives the quicksight policy. */
  readonly quickUserRole: QuickUserRole;
}

/**
 * The IAM role Quick Web federated users assume. The Web portal's Lambda role is
 * the only principal allowed to assume it, and it may pass an `Email` principal
 * tag (sts:TagSession) — Quick keys the federated user on that tag.
 *
 * Quick self-provisions first-time users based on which quicksight:Create* action
 * this role's policy allows (see QuickUserRole). `reader`/`author` grant only that
 * single action scoped to the caller's own user record; `admin` grants quicksight:*
 * so the sample works fully out of the box.
 */
export class FederationRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: FederationRoleProps) {
    super(scope, id);

    const { projectName, quickUserRole } = props;
    const { account, partition } = Stack.of(this);

    // Self-provision resource per the AWS federation examples: the user record the
    // caller creates for themselves. `${aws:userid}` is an IAM policy variable
    // resolved at evaluation time (quicksight user ARNs carry no region).
    // Pro roles are provisioned by the portal via RegisterUser before sign-in; the
    // base Create* action here is only a fallback if that registration ever fails.
    const selfUserArn = `arn:${partition}:quicksight::${account}:user/\${aws:userid}`;
    const policyByBaseRole: Record<string, PolicyStatement> = {
      [QuickUserRole.READER]: new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['quicksight:CreateReader'],
        resources: [selfUserArn],
      }),
      [QuickUserRole.AUTHOR]: new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['quicksight:CreateUser'],
        resources: [selfUserArn],
      }),
      [QuickUserRole.ADMIN]: new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['quicksight:*'],
        resources: ['*'],
      }),
    };

    this.role = new Role(this, createConstructId('Role'), {
      roleName: createResourceName(projectName, ResourceName.FEDERATION_ROLE),
      // Assumed by the portal Lambda's execution role (added by the stack via
      // grantAssume once that role exists — see stack). Placeholder self-account
      // principal keeps the trust valid until then.
      assumedBy: new ArnPrincipal(`arn:aws:iam::${account}:root`),
      description: 'Assumed by the Web portal to federate Feishu users into Quick',
      // The portal Lambda assumes this via role chaining, which STS hard-caps at
      // 1h regardless of this value. Kept at 1h so the setting matches reality.
      maxSessionDuration: Duration.hours(1),
      inlinePolicies: {
        QuickAccess: new PolicyDocument({
          statements: [policyByBaseRole[toBaseRole(quickUserRole)]],
        }),
      },
    });

    if (toBaseRole(quickUserRole) === QuickUserRole.ADMIN) {
      acknowledgeRule(
        this,
        'AwsSolutions-IAM5[Action::quicksight:*]',
        'quicksight:* is granted only when the operator explicitly selects ' +
          '-c quickUserRole=admin, so federated admins land in a fully working Quick; ' +
          'the trust policy is already restricted to the portal Lambda role only.',
      );
      acknowledgeRule(
        this,
        'AwsSolutions-IAM5[Resource::*]',
        'QuickSight console access actions do not support resource-level scoping for ' +
          'the sign-in path; access is bounded by the quicksight service prefix and the ' +
          'Email session tag that Quick keys users on.',
      );
    }
  }

  /**
   * Restrict the trust policy to exactly the portal Lambda role and allow it to
   * tag the session with Email. Called by the stack once the Lambda role exists.
   */
  public trustPortal(portalRoleArn: string): void {
    const cfnRole = this.role.node.defaultChild as CfnRole;
    cfnRole.assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: portalRoleArn },
          Action: 'sts:AssumeRole',
        },
        {
          Effect: 'Allow',
          Principal: { AWS: portalRoleArn },
          Action: 'sts:TagSession',
          Condition: { StringLike: { 'aws:RequestTag/Email': '*' } },
        },
      ],
    };
  }
}
