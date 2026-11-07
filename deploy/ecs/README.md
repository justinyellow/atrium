# Atrium on ECS

Templates for running the Atrium image on AWS ECS. Full guide: `docs/DEPLOYMENT.md`.

- `task-definition.json`: Fargate/ARM64 task with env + Secrets Manager secrets. Replace every `<…>` placeholder.
- `task-role-policy.json`: task role, S3 uploads access (least privilege).
- `execution-role-secrets-policy.json`: execution role, read the DB password and setup token secrets.

These templates use common ECS defaults. They were **not** checked against any specific AWS account; align log groups, secrets, ECR naming and networking with your own conventions.
(the AWS discovery tool was unavailable). Before use, align with house conventions: launch type (Fargate vs EC2),
CPU architecture, secrets source (Secrets Manager vs SSM), log group naming, task role naming, ECR repo naming and region.

Minimum checklist:
1. ECR repo `atrium`; push the multi-arch image.
2. RDS PostgreSQL database + user; password in Secrets Manager.
3. ElastiCache Redis (required for more than one task).
4. Private S3 bucket for uploads; attach `task-role-policy.json` to the task role.
5. Secret `atrium/setup-token`.
6. Target group: port 3100, health check `/api/v1/ready`; ALB idle timeout ≥ 300s; HTTPS listener, all paths to this target group.
7. Service: desired count 2 across two AZs (1 if no Redis), deregistration delay 30s.
