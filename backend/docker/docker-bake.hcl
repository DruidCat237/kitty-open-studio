# `docker buildx bake --push` in this folder reads docker-compose.yml (the kitty-backend service: build context,
# Dockerfile, build args) together with this file, builds the image and pushes both tags.
# Another registry or version, PowerShell:  $env:IMAGE="docker.io/<you>/kitty-open-studio"; $env:VERSION="0.1.1"
#                                    bash:  IMAGE=docker.io/<you>/kitty-open-studio VERSION=0.1.1 docker buildx bake --push
variable "IMAGE" {
  default = "druidcat/kitty-open-studio"
}

variable "VERSION" {
  default = "0.1.1"
}

group "default" {
  targets = ["kitty-backend"]
}

target "kitty-backend" {
  tags      = ["${IMAGE}:${VERSION}", "${IMAGE}:latest"]
  platforms = ["linux/amd64"]
  # One plain manifest without an attestation index: what Runpod pulls most reliably.
  attest = ["type=provenance,disabled=true", "type=sbom,disabled=true"]
  args = {
    KITTY_VERSION = "${VERSION}"
  }
  labels = {
    "org.opencontainers.image.version" = "${VERSION}"
  }
}
