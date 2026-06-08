// @tasca/broker — the credential broker that keeps the GitHub App master key inside
// the worker, out of the agent-runner. The worker runs serveBroker (holding the key
// in the injected mint); the runner uses brokerClient (socket path only).
export type {
  RepoToken,
  RepoTokenMinter,
  CredentialBroker,
  BrokerRequest,
  BrokerResponse,
} from './contract';
export { REPO_REF_RE, isValidRepoRef } from './contract';
export { serveBroker, type BrokerServerOptions, type BrokerServerHandle, type BrokerLogger } from './server';
export { brokerClient, type BrokerClientOptions } from './client';
