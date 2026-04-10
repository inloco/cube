CUBE_VERSION=$(shell node -e "console.log(require('./packages/cubejs-docker/package.json').version);")
GIT_REV := $(shell git rev-parse --short HEAD)
DIRTY_FLAG := $(shell git diff HEAD --quiet || echo '-dirty')
IMAGE_VERSION=${CUBE_VERSION}-${GIT_REV}${DIRTY_FLAG}

# Default environment is staging
ENV ?= staging

# AWS Account IDs
STAGING_ACCOUNT := 238972146049
PRODUCTION_ACCOUNT := 889818756387

ifeq ($(ENV), production)
    AWS_ACCOUNT := $(PRODUCTION_ACCOUNT)
else
    AWS_ACCOUNT := $(STAGING_ACCOUNT)
endif

IMAGE=${AWS_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/incognia/cube:${IMAGE_VERSION}
CUBESTORE_IMAGE=${AWS_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/incognia/cubestore:${IMAGE_VERSION}

.PHONY: build cubestore/build api/build

# Main build command
build: cubestore/build api/build

# Build API only
api/build:
	docker build --platform linux/amd64 -t ${IMAGE} . -f incognia.Dockerfile --build-arg IMAGE_VERSION=${IMAGE_VERSION}

# Build apenas do Cube Store (Rust)
cubestore/build:
	docker build --platform linux/amd64 --build-arg WITH_AVX2=0 -t ${CUBESTORE_IMAGE} rust/ -f rust/cubestore/Dockerfile --build-arg CARGO_NET_GIT_FETCH_WITH_CLI=true --build-arg RUST_MIN_STACK=16777216
