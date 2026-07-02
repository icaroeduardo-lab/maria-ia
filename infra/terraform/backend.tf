# State remoto no S3 com lock no DynamoDB.
# Criar UMA vez, antes do primeiro `terraform init`:
#   aws s3api create-bucket --bucket maria-tfstate --region us-east-1
#   aws s3api put-bucket-versioning --bucket maria-tfstate --versioning-configuration Status=Enabled
#   aws dynamodb create-table --table-name maria-tf-lock \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
#
# Depois preencher os nomes abaixo e rodar `terraform init`.
terraform {
  backend "s3" {
    bucket         = "maria-tfstate-185327115563"
    key            = "aws-fargate-v2/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "maria-tf-lock"
    encrypt        = true
  }
}
