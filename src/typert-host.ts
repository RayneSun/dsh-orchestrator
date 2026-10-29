import { TYPERT_REMOTE } from './remote.ts'

/** 手写 Host FaceModel：供 typert-loader 在不修改官方 DSH 的前提下注册 strict descriptor。 */
export const TYPERT = {
  package: '@may/dsh-orchestrator',
  face: 'host' as const,
  schemas: [],
  model: {
    services: [{
      key: 'orchestrator',
      exportName: 'OrchestratorService',
      tags: [],
      members: [{
        kind: 'method' as const,
        name: 'snapshot',
        signature: 'snapshot(request: SnapshotRequest): Promise<Snapshot>',
        tags: [],
      }, {
        kind: 'method' as const,
        name: 'setTodoStatus',
        signature: 'setTodoStatus(request: SetTodoStatusRequest): Promise<SetTodoStatusResult>',
        tags: [],
      }],
      types: [],
    }],
    events: [],
    objects: [],
  },
  invocations: TYPERT_REMOTE.descriptors,
}

export default TYPERT
