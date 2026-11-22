// The demo server: gRPC service + server reflection, both driven by the same
// descriptor set. Run with `node demo/server.js` (or `npm run start:demo`).
import * as grpc from "@grpc/grpc-js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { loadDemoDescriptorSet } from "../server/registry.js";
import { reflectionTypes } from "../server/reflection.js";
import { declaredSymbols } from "../server/descriptors.js";
import { buildCollectorImplementation, collectorServiceDefinition } from "./service.js";

const { registry, fileBytes } = loadDemoDescriptorSet();

const HOST = process.env.DEMO_HOST || "127.0.0.1";
const PORT = Number(process.env.DEMO_PORT || 50051);

/**
 * A minimal server-reflection implementation over our descriptor set.
 * It supports list_services, file_containing_symbol and file_by_filename and
 * returns the full dependency closure for each.
 */
function registerReflection(server) {
  for (const version of ["v1", "v1alpha"]) {
    const types = reflectionTypes(version);
    const Request = types.request;
    const Response = types.response;
    const serviceDef = {
      ServerReflectionInfo: {
        path: `/${types.service}/ServerReflectionInfo`,
        requestStream: true,
        responseStream: true,
        requestSerialize: (value) => Buffer.from(toBinary(Request, value)),
        requestDeserialize: (bytes) => fromBinary(Request, bytes),
        responseSerialize: (value) => Buffer.from(toBinary(Response, value)),
        responseDeserialize: (bytes) => fromBinary(Response, bytes),
      },
    };

    const symbolToFile = new Map();
    for (const file of registry.files) {
      if (!registry.getFile(file.proto.name)) continue;
      for (const symbol of declaredSymbols(file.proto)) {
        symbolToFile.set(symbol, file.proto.name);
      }
    }

    const closure = (fileName) => {
      const out = [];
      const seen = new Set();
      const walk = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const file = registry.getFile(name);
        if (!file) return;
        for (const dep of file.proto.dependency) walk(dep);
        const bytes = fileBytes.get(name);
        if (bytes) out.push(bytes);
      };
      walk(fileName);
      return out;
    };

    const respond = (request) => {
      const branch = request.messageRequest;
      const reply = (messageResponse) =>
        create(Response, { validHost: request.host, originalRequest: request, messageResponse });
      const notFound = (detail) =>
        reply({
          case: "errorResponse",
          value: create(registry.getMessage(`grpc.reflection.${version}.ErrorResponse`), {
            errorCode: grpc.status.NOT_FOUND,
            errorMessage: detail,
          }),
        });

      switch (branch.case) {
        case "listServices": {
          const ListServiceResponse = registry.getMessage(
            `grpc.reflection.${version}.ListServiceResponse`,
          );
          const names = new Set();
          for (const file of registry.files) {
            for (const service of file.services) names.add(service.typeName);
          }
          return reply({
            case: "listServicesResponse",
            value: create(ListServiceResponse, {
              service: [...names].sort().map((name) => ({ name })),
            }),
          });
        }
        case "fileContainingSymbol": {
          const fileName = symbolToFile.get(branch.value);
          if (!fileName) return notFound(`symbol not found: ${branch.value}`);
          return reply({
            case: "fileDescriptorResponse",
            value: {
              fileDescriptorProto: closure(fileName),
            },
          });
        }
        case "fileByFilename": {
          if (!registry.getFile(branch.value)) {
            return notFound(`file not found: ${branch.value}`);
          }
          return reply({
            case: "fileDescriptorResponse",
            value: {
              fileDescriptorProto: closure(branch.value),
            },
          });
        }
        default:
          return reply({
            case: "errorResponse",
            value: create(registry.getMessage(`grpc.reflection.${version}.ErrorResponse`), {
              errorCode: grpc.status.UNIMPLEMENTED,
              errorMessage: `unsupported reflection request: ${branch.case}`,
            }),
          });
      }
    };

    server.addService(serviceDef, {
      ServerReflectionInfo(call) {
        call.on("data", (request) => {
          call.write(respond(request));
        });
        call.on("end", () => call.end());
        call.on("error", () => call.end());
      },
    });
  }
}

export async function startDemoServer({ host = HOST, port = PORT } = {}) {
  const server = new grpc.Server();
  server.addService(collectorServiceDefinition(), buildCollectorImplementation());
  registerReflection(server);
  const bound = await new Promise((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });
  return { server, port: bound };
}

const isMain = process.argv[1] && process.argv[1].endsWith("demo/server.js");
if (isMain) {
  startDemoServer().then(({ port }) => {
    console.log(`demo gRPC server listening on ${HOST}:${port} (reflection: v1 + v1alpha)`);
  });
}
