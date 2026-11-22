// A server-reflection client built on grpc-js and protobuf-es.
//
// It speaks both grpc.reflection.v1 and the older v1alpha (some servers still
// only expose the latter), and it resolves the full import closure of a
// symbol so no descriptor is left dangling.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import * as grpc from "@grpc/grpc-js";
import { loadDemoDescriptorSet } from "./registry.js";
import { buildRegistry, referencedTypeNames } from "./descriptors.js";

const { registry: localRegistry } = loadDemoDescriptorSet();

const VERSIONS = ["v1", "v1alpha"];

export class ReflectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReflectionError";
    this.code = code;
  }
}

export function reflectionTypes(version) {
  const pkg = `grpc.reflection.${version}`;
  const request = localRegistry.getMessage(`${pkg}.ServerReflectionRequest`);
  const response = localRegistry.getMessage(`${pkg}.ServerReflectionResponse`);
  if (!request || !response) {
    throw new Error(`reflection descriptors for ${pkg} are missing`);
  }
  return { service: `${pkg}.ServerReflection`, request, response };
}

/**
 * One reflection exchange: open a stream, write one request, read the first
 * response. Works with servers that implement only the minimum.
 */
function exchange(client, version, request) {
  const types = reflectionTypes(version);
  const path = `/${types.service}/ServerReflectionInfo`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream;
    try {
      stream = client.makeBidiStreamRequest(
        path,
        (value) => Buffer.from(toBinary(types.request, value)),
        (bytes) => fromBinary(types.response, bytes),
      );
    } catch (error) {
      reject(error);
      return;
    }
    // A server may close the stream after answering; only the first outcome
    // counts.
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners("data");
      stream.removeAllListeners("error");
      stream.removeAllListeners("end");
      try {
        stream.end();
      } catch {
        /* already closed */
      }
      fn(value);
    };
    stream.on("data", (response) => {
      const branch = response.messageResponse;
      if (branch.case === "errorResponse") {
        finish(
          reject,
          new ReflectionError(
            branch.value.errorCode,
            branch.value.errorMessage || "reflection error",
          ),
        );
        return;
      }
      finish(resolve, response);
    });
    stream.on("error", (error) => finish(reject, error));
    stream.on("end", () =>
      finish(
        reject,
        new ReflectionError(grpc.status.UNKNOWN, "reflection stream ended without a response"),
      ),
    );
    try {
      stream.write(request);
      stream.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

export class ReflectionClient {
  constructor(target, { tls = false } = {}) {
    this.target = target;
    this.client = new grpc.Client(
      target,
      tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    );
    this.version = null;
  }

  close() {
    this.client.close();
  }

  async detectVersion() {
    if (this.version) return this.version;
    const failures = [];
    for (const version of VERSIONS) {
      try {
        await exchange(
          this.client,
          version,
          create(reflectionTypes(version).request, {
            messageRequest: { case: "listServices", value: "*" },
          }),
        );
        this.version = version;
        return version;
      } catch (error) {
        failures.push(`${version}: ${error?.message ?? error}`);
      }
    }
    throw new ReflectionError(
      grpc.status.UNIMPLEMENTED,
      `server reflection is unavailable on ${this.target} (${failures.join("; ")})`,
    );
  }

  async listServices() {
    const version = await this.detectVersion();
    const response = await exchange(
      this.client,
      version,
      create(reflectionTypes(version).request, {
        host: this.target,
        messageRequest: { case: "listServices", value: "*" },
      }),
    );
    const branch = response.messageResponse;
    if (branch.case !== "listServicesResponse") {
      throw new ReflectionError(grpc.status.UNKNOWN, "unexpected response for listServices");
    }
    return {
      version,
      services: branch.value.service.map((s) => s.name),
    };
  }

  /** Fetch the descriptors a single reflection request returns. */
  async describe(version, messageRequest) {
    const response = await exchange(
      this.client,
      version,
      create(reflectionTypes(version).request, {
        host: this.target,
        messageRequest,
      }),
    );
    const branch = response.messageResponse;
    if (branch.case !== "fileDescriptorResponse") {
      throw new ReflectionError(grpc.status.UNKNOWN, `unexpected response: ${branch.case}`);
    }
    return branch.value.fileDescriptorProto.map((bytes) =>
      fromBinary(FileDescriptorProtoSchema, bytes),
    );
  }

  /**
   * Resolve a symbol's descriptor closure.
   *
   * The spec says file_containing_symbol includes transitive dependencies, but
   * not every implementation complies, so we walk `dependency` and fetch what
   * is missing. If a referenced type is still unknown we ask for it by symbol
   * as a last resort.
   */
  async resolveSymbol(symbol) {
    const version = await this.detectVersion();
    const files = new Map();

    const absorb = (list) => {
      let added = 0;
      for (const file of list) {
        if (!files.has(file.name)) {
          files.set(file.name, file);
          added += 1;
        }
      }
      return added;
    };

    absorb(await this.describe(version, { case: "fileContainingSymbol", value: symbol }));

    const fetchMissingDependencies = async () => {
      for (let round = 0; round < 8; round += 1) {
        const missing = new Set();
        for (const file of files.values()) {
          for (const dep of file.dependency) {
            if (!files.has(dep)) missing.add(dep);
          }
        }
        if (missing.size === 0) return;
        let fetched = 0;
        await Promise.all(
          [...missing].map(async (dep) => {
            try {
              fetched += absorb(
                await this.describe(version, { case: "fileByFilename", value: dep }),
              );
            } catch (error) {
              if (error?.code !== grpc.status.NOT_FOUND) throw error;
            }
          }),
        );
        if (fetched === 0) return;
      }
    };

    await fetchMissingDependencies();

    let built = buildRegistry([...files.values()]);
    let unresolved = this.unresolved(built.registry, files);

    // Ask for missing types by symbol. Some proxies omit imports entirely.
    for (const name of unresolved.missingTypes) {
      try {
        const before = files.size;
        absorb(await this.describe(version, { case: "fileContainingSymbol", value: name }));
        if (files.size === before) continue;
        await fetchMissingDependencies();
        built = buildRegistry([...files.values()]);
        unresolved = this.unresolved(built.registry, files);
        if (unresolved.missingTypes.length === 0) break;
      } catch (error) {
        if (error?.code !== grpc.status.NOT_FOUND) throw error;
      }
    }

    unresolved = this.unresolved(built.registry, files);
    if (unresolved.missingTypes.length > 0 || unresolved.missingFiles.length > 0) {
      const parts = [];
      if (unresolved.missingTypes.length) parts.push(`types: ${unresolved.missingTypes.join(", ")}`);
      if (unresolved.missingFiles.length) parts.push(`files: ${unresolved.missingFiles.join(", ")}`);
      throw new ReflectionError(
        grpc.status.FAILED_PRECONDITION,
        `reflection descriptors are incomplete (${parts.join("; ")})`,
      );
    }

    const { registry } = built;
    const service = registry.getService(symbol);
    const message = registry.getMessage(symbol);
    const enumType = registry.getEnum(symbol);
    if (!service && !message && !enumType) {
      throw new ReflectionError(grpc.status.NOT_FOUND, `${symbol} not found in descriptors`);
    }

    return {
      version,
      registry,
      symbol,
      service,
      message,
      enum: enumType,
      files: built.files.map((file) => file.name),
      fileDescriptors: files,
    };
  }

  unresolved(registry, files) {
    const missingFiles = [...files.keys()].filter((name) => !registry.getFile(name));
    const missingTypes = new Set();
    for (const file of files.values()) {
      for (const name of referencedTypeNames(file)) {
        if (!registry.get(name)) missingTypes.add(name);
      }
    }
    return { missingFiles, missingTypes: [...missingTypes] };
  }
}
