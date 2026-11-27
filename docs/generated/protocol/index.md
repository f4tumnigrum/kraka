# Protocol reference

Generated from `packages/protocol/src/schemas.ts`.

## Client requests

Supply a fresh public nonce in the upgrade query and verify its signed echo with the expected environment key. After a verified hello, authenticate and install the configuration for the same environment. Each signed business request requires an object grant and must fit the signer kind's ceiling. The environment resolves object ownership before accepting the request. A challenge belongs to one connection. Sequences increase within that challenge. Retries retain the business command ID.

| Method | Required permission | Grant target |
|---|---|---|
| `access.listGrants` | `access.give` | authorizationTarget |
| `access.listChanges` | `access.give` | authorizationTarget |
| `device.pairing.listInvites` | `access.give` | authorizationTarget |
| `device.pairing.listApplications` | `access.give` | authorizationTarget |
| `device.pairing.cancel` | `access.give` | authorizationTarget |
| `thread.readEarlierSettled` | `thread.view` | authorizationTarget |
| `thread.changeLifecycle` | `thread.send` | thread |
| `thread.compact` | `thread.send` | thread |
| `thread.clear` | `thread.send` | thread |
| `input.editQueued` | `thread.send` | thread |
| `input.cancelQueued` | `thread.send` | thread |
| `input.reorderQueue` | `thread.send` | thread |
| `checkpoint.readRollbackPart` | `thread.view` | thread |
| `checkpoint.retryDialogue` | `thread.send` | thread |
| `checkpoint.retryFiles` | `workspace.change` | thread |
| `git.readStatus` | `thread.view` | workspace |
| `git.subscribeStatus` | `thread.view` | workspace |
| `workspace.list` | `thread.view` | workspace |
| `workspace.readFile` | `thread.view` | workspace |
| `workspace.writeFile` | `workspace.change and thread.view` | workspace |
| `workspace.search` | `thread.view` | workspace |
| `host.listDirectory` | `thread.view` | environment |
| `workspace.openEditor` | `workspace.change and thread.view` | workspace |
| `todo.readSecretReceipt` | `owner.decide` | thread |
| `thread.inspectCheckout` | `thread.view` | thread |
| `thread.launchChildren` | `thread.send` | thread |
| `thread.readChild` | `thread.view` | thread |
| `thread.cancelChild` | `thread.send` | thread |
| `app.callback` | `thread.view` | thread |
| `app.confirm` | `owner.decide` | thread |
| `app.updateNote` | `thread.send` | thread |
| `environment.upgrade` | `environment.upgrade` | environment |
| `forge.publish` | `workspace.change` | thread |
| `forge.operation` | `thread.view` | thread |
| `forge.fileReading` | `thread.view` | thread |
| `forge.markFile` | `thread.view` | thread |
| `forge.history` | `thread.view` | thread |
| `checkpoint.diff` | `thread.view` | thread |
| `checkpoint.rollbackDialogue` | `thread.send` | thread |
| `checkpoint.restoreFiles` | `workspace.change` | thread |
| `checkpoint.rollback` | `thread.send and workspace.change` | thread |
| `terminal.open` | `term.input` | thread |
| `terminal.attach` | `term.view` | thread |
| `terminal.control` | `term.input` | thread |
| `terminal.write` | `term.input` | thread |
| `terminal.resize` | `term.view` | thread |
| `terminal.ack` | `term.view` | thread |
| `terminal.detach` | `term.view` | thread |
| `terminal.close` | `term.input` | thread |
| `worktree.prepare` | `workspace.change` | project |
| `worktree.retrySetup` | `workspace.change` | project |
| `worktree.clean` | `workspace.change` | project |
| `settings.read` | `thread.view` | authorizationTarget |
| `settings.write` | `settings.change` | authorizationTarget |
| `attention.read` | `thread.view` | thread |
| `executor.configure` | `settings.change` | environment |
| `executor.refresh` | `thread.view` | project |
| `project.register` | `workspace.change` | environment |
| `thread.rename` | `thread.send` | thread |
| `thread.start` | `thread.send` | project |
| `input.send` | `thread.send` | thread |
| `input.steer` | `thread.send` | thread |
| `input.releaseQueue` | `thread.send` | thread |
| `round.readStop` | `thread.view` | thread |
| `round.stop` | `thread.send` | thread |
| `input.resendUnknown` | `thread.send` | thread |
| `input.dropUnknown` | `thread.send` | thread |
| `todo.readAnswer` | `thread.view` | thread |
| `todo.answer` | `thread.reply` | thread |
| `todo.decide` | `owner.decide` | thread |
| `access.grant` | `access.give` | authorizationTarget |
| `access.revoke` | `access.give` | authorizationTarget |
| `access.listSessions` | `access.give` | environment |
| `device.pairing.invite` | `access.give` | project |
| `device.pairing.approve` | `access.give` | project |
| `device.revoke` | `access.give` | environment |
| `subscription.openThread` | `thread.view` | thread |
| `subscription.openList` | `thread.view` | environment |
| `thread.readHistory` | `thread.view` | thread |
| `tool.readActivity` | `thread.view` | thread |
| `history.pageSaved` | `thread.view` | thread |
| `subscription.close` | `thread.view` | subscription |
| `subscription.pageSaved` | `thread.view` | subscription |
| `subscription.installed` | `thread.view` | subscription |
| `subscription.gap` | `thread.view` | subscription |
| `attachment.upload` | `thread.send` | authorizationTarget |
| `attachment.download` | `thread.view` | attachment |

Pairing and authentication exchange proofs before an authorized session exists. Replies, flow windows and subscription pages belong to that connection or its already authorized stream.

A binary content message contains a four-byte unsigned big-endian JSON-header length, that many UTF-8 header bytes, and the raw chunk in the same WebSocket message. Validate the header and the remaining payload length before accepting the chunk. Other messages carry the frame header as JSON text. Use transport.content for oversized JSON: its authorized connection opens a nonzero stream for chunks of one logical message. Reassemble the declared byte length, then strictly decode the original message and enforce its own signature and object permissions before dispatch. Reserve stream zero for control. Subscription data retains its own flow budget.

## AccessChange

```json
{
  "type": "object",
  "properties": {
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "actorId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "target": {
      "$ref": "#/$defs/AuthorizationTarget"
    },
    "change": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "granted"
            },
            "grant": {
              "$ref": "#/$defs/PermissionGrant"
            }
          },
          "required": [
            "kind",
            "grant"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "revoked"
            },
            "grantId": {
              "$ref": "#/$defs/AccessGrantId"
            }
          },
          "required": [
            "kind",
            "grantId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "commandId",
    "actorId",
    "at",
    "target",
    "change"
  ],
  "additionalProperties": false
}
```

## AccessGrantId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ActivePrincipal

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/DevicePrincipal"
    },
    {
      "$ref": "#/$defs/ExecutorPrincipal"
    }
  ]
}
```

## AdapterFamily

```json
{
  "enum": [
    "codex",
    "claude-code",
    "opencode",
    "pi",
    "antigravity",
    "acp",
    "replay"
  ],
  "type": "string"
}
```

## AnswerArrival

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "viaMessage"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "recorded"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "armed"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "handed"
        },
        "wroteAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "wroteAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "uncertain"
        },
        "next": {
          "const": "inspectAnswer"
        }
      },
      "required": [
        "kind",
        "next"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "received"
        },
        "proof": {
          "$ref": "#/$defs/AnswerProof"
        }
      },
      "required": [
        "kind",
        "proof"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "rejected"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## AnswerAttempt

```json
{
  "type": "object",
  "properties": {
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "deliveryId": {
      "$ref": "#/$defs/DeliveryId"
    },
    "arrival": {
      "$ref": "#/$defs/AnswerArrival"
    }
  },
  "required": [
    "attemptId",
    "deliveryId",
    "arrival"
  ],
  "additionalProperties": false
}
```

## AnswerProof

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/NativeSessionId"
    },
    "requestId": {
      "$ref": "#/$defs/NativeRequestId"
    }
  },
  "required": [
    "sessionId",
    "requestId"
  ],
  "additionalProperties": false
}
```

## AppAction

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool"
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "argumentsJson": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "name",
        "argumentsJson"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "resource"
        },
        "uri": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "uri"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "message"
        },
        "text": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "text"
      ],
      "additionalProperties": false
    }
  ]
}
```

## AppCallback

```json
{
  "type": "object",
  "properties": {
    "source": {
      "$ref": "#/$defs/AppSource"
    },
    "action": {
      "$ref": "#/$defs/AppAction"
    }
  },
  "required": [
    "source",
    "action"
  ],
  "additionalProperties": false
}
```

## AppConfirmation

```json
{
  "type": "object",
  "properties": {
    "source": {
      "$ref": "#/$defs/AppSource"
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "confirmedBy": {
      "$ref": "#/$defs/PrincipalId"
    },
    "payloadDigest": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "issuedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "source",
    "commandId",
    "confirmedBy",
    "payloadDigest",
    "issuedAt",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

## AppNote

```json
{
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "targetThreadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "source": {
          "type": "object",
          "properties": {
            "environmentId": {
              "$ref": "#/$defs/EnvironmentId"
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "itemId": {
              "$ref": "#/$defs/TimelineItemId"
            }
          },
          "required": [
            "environmentId",
            "threadId",
            "itemId"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "targetThreadId",
        "source"
      ],
      "additionalProperties": false
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "text": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "key",
    "version",
    "updatedAt",
    "text"
  ],
  "additionalProperties": false
}
```

## AppNoteRead

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "deliveryId": {
      "$ref": "#/$defs/DeliveryId"
    },
    "result": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "present"
            },
            "notes": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "object",
                  "properties": {
                    "key": {
                      "type": "object",
                      "properties": {
                        "targetThreadId": {
                          "$ref": "#/$defs/ThreadId"
                        },
                        "source": {
                          "type": "object",
                          "properties": {
                            "environmentId": {
                              "$ref": "#/$defs/EnvironmentId"
                            },
                            "threadId": {
                              "$ref": "#/$defs/ThreadId"
                            },
                            "itemId": {
                              "$ref": "#/$defs/TimelineItemId"
                            }
                          },
                          "required": [
                            "environmentId",
                            "threadId",
                            "itemId"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "targetThreadId",
                        "source"
                      ],
                      "additionalProperties": false
                    },
                    "version": {
                      "$ref": "#/$defs/ObjectVersion"
                    },
                    "updatedAt": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "key",
                    "version",
                    "updatedAt",
                    "text"
                  ],
                  "additionalProperties": false
                }
              ],
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "object",
                    "properties": {
                      "targetThreadId": {
                        "$ref": "#/$defs/ThreadId"
                      },
                      "source": {
                        "type": "object",
                        "properties": {
                          "environmentId": {
                            "$ref": "#/$defs/EnvironmentId"
                          },
                          "threadId": {
                            "$ref": "#/$defs/ThreadId"
                          },
                          "itemId": {
                            "$ref": "#/$defs/TimelineItemId"
                          }
                        },
                        "required": [
                          "environmentId",
                          "threadId",
                          "itemId"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "required": [
                      "targetThreadId",
                      "source"
                    ],
                    "additionalProperties": false
                  },
                  "version": {
                    "$ref": "#/$defs/ObjectVersion"
                  },
                  "updatedAt": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "text": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "key",
                  "version",
                  "updatedAt",
                  "text"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "kind",
            "notes"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "empty"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "failed"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "threadId",
    "deliveryId",
    "result"
  ],
  "additionalProperties": false
}
```

## AppSource

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "itemId": {
      "$ref": "#/$defs/TimelineItemId"
    },
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "sessionId": {
      "$ref": "#/$defs/NativeSessionId"
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "generation": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "serviceId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "environmentId",
    "threadId",
    "itemId",
    "instanceId",
    "sessionId",
    "attemptId",
    "generation",
    "serviceId"
  ],
  "additionalProperties": false
}
```

## AttachmentId

```json
{
  "type": "string",
  "minLength": 1
}
```

## AttachmentReference

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "enum": [
        "text",
        "image",
        "file"
      ],
      "type": "string"
    },
    "id": {
      "$ref": "#/$defs/AttachmentId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "kind",
    "id",
    "version"
  ],
  "additionalProperties": false
}
```

## AttemptId

```json
{
  "type": "string",
  "minLength": 1
}
```

## AttentionFacts

```json
{
  "type": "object",
  "properties": {
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "databaseGeneration": {
      "type": "string",
      "minLength": 1
    },
    "through": {
      "$ref": "#/$defs/SyncPosition"
    },
    "root": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "readThrough": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncPosition"
            },
            {
              "type": "null"
            }
          ]
        },
        "grouping": {
          "enum": [
            "ordinary",
            "settled",
            "archived"
          ],
          "type": "string"
        },
        "requests": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "request": {
                "type": "object",
                "properties": {
                  "id": {
                    "$ref": "#/$defs/TodoRequestId"
                  },
                  "body": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "approval"
                          },
                          "tool": {
                            "enum": [
                              "command",
                              "file",
                              "other"
                            ],
                            "type": "string"
                          },
                          "choices": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "key": {
                                  "type": "string"
                                },
                                "scope": {
                                  "enum": [
                                    "once",
                                    "session",
                                    "project",
                                    "persistent",
                                    "unknown"
                                  ],
                                  "type": "string"
                                },
                                "allowsEdit": {
                                  "type": "boolean"
                                }
                              },
                              "required": [
                                "key",
                                "scope",
                                "allowsEdit"
                              ],
                              "additionalProperties": false
                            }
                          }
                        },
                        "required": [
                          "kind",
                          "tool",
                          "choices"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "question"
                          },
                          "questions": {
                            "type": "array",
                            "prefixItems": [
                              {
                                "type": "object",
                                "properties": {
                                  "key": {
                                    "type": "string"
                                  },
                                  "text": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "choices": {
                                    "type": "array",
                                    "items": {
                                      "type": "string"
                                    }
                                  }
                                },
                                "required": [
                                  "key",
                                  "text",
                                  "choices"
                                ],
                                "additionalProperties": false
                              }
                            ],
                            "minItems": 1,
                            "items": {
                              "type": "object",
                              "properties": {
                                "key": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "choices": {
                                  "type": "array",
                                  "items": {
                                    "type": "string"
                                  }
                                }
                              },
                              "required": [
                                "key",
                                "text",
                                "choices"
                              ],
                              "additionalProperties": false
                            }
                          }
                        },
                        "required": [
                          "kind",
                          "questions"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "secret"
                          },
                          "slot": {
                            "type": "string"
                          },
                          "purpose": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "const": "toolOnce"
                                  },
                                  "tool": {
                                    "type": "string",
                                    "minLength": 1
                                  }
                                },
                                "required": [
                                  "kind",
                                  "tool"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "const": "commandFile"
                                  },
                                  "tool": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "commandId": {
                                    "$ref": "#/$defs/CommandId"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "tool",
                                  "commandId"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        },
                        "required": [
                          "kind",
                          "slot"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "state": {
                    "$ref": "#/$defs/TodoState"
                  }
                },
                "required": [
                  "id",
                  "body",
                  "state"
                ],
                "additionalProperties": false
              },
              "openedAt": {
                "$ref": "#/$defs/SyncPosition"
              }
            },
            "required": [
              "request",
              "openedAt"
            ],
            "additionalProperties": false
          }
        },
        "rounds": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "round": {
                "type": "object",
                "properties": {
                  "id": {
                    "$ref": "#/$defs/RoundId"
                  },
                  "attempt": {
                    "$ref": "#/$defs/RoundAttempt"
                  }
                },
                "required": [
                  "id",
                  "attempt"
                ],
                "additionalProperties": false
              },
              "changedAt": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)$",
                "description": "Occurrence position. For a terminal attempt this is the original end position, including after later receipt or capture updates."
              },
              "quota": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "resetAt": {
                        "anyOf": [
                          {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 9007199254740991
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "resetAt"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "review": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "enum": [
                          "plan",
                          "work"
                        ],
                        "type": "string"
                      },
                      "deferredAtEnd": {
                        "type": "boolean"
                      }
                    },
                    "required": [
                      "kind",
                      "deferredAtEnd"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "round",
              "changedAt",
              "quota",
              "review"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "threadId",
        "readThrough",
        "grouping",
        "requests",
        "rounds"
      ],
      "additionalProperties": false
    },
    "descendants": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "threadId": {
            "$ref": "#/$defs/ThreadId"
          },
          "readThrough": {
            "anyOf": [
              {
                "$ref": "#/$defs/SyncPosition"
              },
              {
                "type": "null"
              }
            ]
          },
          "grouping": {
            "enum": [
              "ordinary",
              "settled",
              "archived"
            ],
            "type": "string"
          },
          "requests": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "request": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "$ref": "#/$defs/TodoRequestId"
                    },
                    "body": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "approval"
                            },
                            "tool": {
                              "enum": [
                                "command",
                                "file",
                                "other"
                              ],
                              "type": "string"
                            },
                            "choices": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "key": {
                                    "type": "string"
                                  },
                                  "scope": {
                                    "enum": [
                                      "once",
                                      "session",
                                      "project",
                                      "persistent",
                                      "unknown"
                                    ],
                                    "type": "string"
                                  },
                                  "allowsEdit": {
                                    "type": "boolean"
                                  }
                                },
                                "required": [
                                  "key",
                                  "scope",
                                  "allowsEdit"
                                ],
                                "additionalProperties": false
                              }
                            }
                          },
                          "required": [
                            "kind",
                            "tool",
                            "choices"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "question"
                            },
                            "questions": {
                              "type": "array",
                              "prefixItems": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "key": {
                                      "type": "string"
                                    },
                                    "text": {
                                      "type": "string",
                                      "minLength": 1
                                    },
                                    "choices": {
                                      "type": "array",
                                      "items": {
                                        "type": "string"
                                      }
                                    }
                                  },
                                  "required": [
                                    "key",
                                    "text",
                                    "choices"
                                  ],
                                  "additionalProperties": false
                                }
                              ],
                              "minItems": 1,
                              "items": {
                                "type": "object",
                                "properties": {
                                  "key": {
                                    "type": "string"
                                  },
                                  "text": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "choices": {
                                    "type": "array",
                                    "items": {
                                      "type": "string"
                                    }
                                  }
                                },
                                "required": [
                                  "key",
                                  "text",
                                  "choices"
                                ],
                                "additionalProperties": false
                              }
                            }
                          },
                          "required": [
                            "kind",
                            "questions"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "secret"
                            },
                            "slot": {
                              "type": "string"
                            },
                            "purpose": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "const": "toolOnce"
                                    },
                                    "tool": {
                                      "type": "string",
                                      "minLength": 1
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "tool"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "const": "commandFile"
                                    },
                                    "tool": {
                                      "type": "string",
                                      "minLength": 1
                                    },
                                    "commandId": {
                                      "$ref": "#/$defs/CommandId"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "tool",
                                    "commandId"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "slot"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    },
                    "state": {
                      "$ref": "#/$defs/TodoState"
                    }
                  },
                  "required": [
                    "id",
                    "body",
                    "state"
                  ],
                  "additionalProperties": false
                },
                "openedAt": {
                  "$ref": "#/$defs/SyncPosition"
                }
              },
              "required": [
                "request",
                "openedAt"
              ],
              "additionalProperties": false
            }
          },
          "rounds": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "round": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "$ref": "#/$defs/RoundId"
                    },
                    "attempt": {
                      "$ref": "#/$defs/RoundAttempt"
                    }
                  },
                  "required": [
                    "id",
                    "attempt"
                  ],
                  "additionalProperties": false
                },
                "changedAt": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]*)$",
                  "description": "Occurrence position. For a terminal attempt this is the original end position, including after later receipt or capture updates."
                },
                "quota": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "resetAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "resetAt"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "review": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "enum": [
                            "plan",
                            "work"
                          ],
                          "type": "string"
                        },
                        "deferredAtEnd": {
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "kind",
                        "deferredAtEnd"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "round",
                "changedAt",
                "quota",
                "review"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "threadId",
          "readThrough",
          "grouping",
          "requests",
          "rounds"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "ownerId",
    "environmentId",
    "databaseGeneration",
    "through",
    "root",
    "descendants"
  ],
  "additionalProperties": false
}
```

## AttentionHint

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "approval",
            "question",
            "secret"
          ],
          "type": "string"
        },
        "key": {
          "type": "object",
          "properties": {
            "ownerId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "environmentId": {
              "$ref": "#/$defs/EnvironmentId"
            },
            "databaseGeneration": {
              "type": "string",
              "minLength": 1
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "object": {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "request"
                },
                "requestId": {
                  "$ref": "#/$defs/TodoRequestId"
                }
              },
              "required": [
                "kind",
                "requestId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "ownerId",
            "environmentId",
            "databaseGeneration",
            "threadId",
            "object"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "key"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "roundFailed",
            "roundCompleted"
          ],
          "type": "string"
        },
        "key": {
          "type": "object",
          "properties": {
            "ownerId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "environmentId": {
              "$ref": "#/$defs/EnvironmentId"
            },
            "databaseGeneration": {
              "type": "string",
              "minLength": 1
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "object": {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "round"
                },
                "roundId": {
                  "$ref": "#/$defs/RoundId"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "roundId",
                "attemptId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "ownerId",
            "environmentId",
            "databaseGeneration",
            "threadId",
            "object"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "key"
      ],
      "additionalProperties": false
    }
  ]
}
```

## AttentionHistory

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "attentionHistory"
    },
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "through": {
      "$ref": "#/$defs/SyncCursor"
    },
    "occurrences": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/AttentionOccurrence"
      }
    },
    "next": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "position": {
              "$ref": "#/$defs/SyncPosition"
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "object": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "request"
                    },
                    "requestId": {
                      "$ref": "#/$defs/TodoRequestId"
                    }
                  },
                  "required": [
                    "kind",
                    "requestId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "round"
                    },
                    "roundId": {
                      "$ref": "#/$defs/RoundId"
                    },
                    "attemptId": {
                      "$ref": "#/$defs/AttemptId"
                    }
                  },
                  "required": [
                    "kind",
                    "roundId",
                    "attemptId"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "position",
            "threadId",
            "object"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "kind",
    "ownerId",
    "through",
    "occurrences",
    "next"
  ],
  "additionalProperties": false
}
```

## AttentionObject

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "attentionObject"
    },
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "databaseGeneration": {
      "type": "string",
      "minLength": 1
    },
    "occurrence": {
      "$ref": "#/$defs/AttentionOccurrence"
    }
  },
  "required": [
    "kind",
    "ownerId",
    "environmentId",
    "databaseGeneration",
    "occurrence"
  ],
  "additionalProperties": false
}
```

## AttentionOccurrence

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "requestOpened"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "request": {
          "type": "object",
          "properties": {
            "id": {
              "$ref": "#/$defs/TodoRequestId"
            },
            "body": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "approval"
                    },
                    "tool": {
                      "enum": [
                        "command",
                        "file",
                        "other"
                      ],
                      "type": "string"
                    },
                    "choices": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "key": {
                            "type": "string"
                          },
                          "scope": {
                            "enum": [
                              "once",
                              "session",
                              "project",
                              "persistent",
                              "unknown"
                            ],
                            "type": "string"
                          },
                          "allowsEdit": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "key",
                          "scope",
                          "allowsEdit"
                        ],
                        "additionalProperties": false
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "tool",
                    "choices"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "question"
                    },
                    "questions": {
                      "type": "array",
                      "prefixItems": [
                        {
                          "type": "object",
                          "properties": {
                            "key": {
                              "type": "string"
                            },
                            "text": {
                              "type": "string",
                              "minLength": 1
                            },
                            "choices": {
                              "type": "array",
                              "items": {
                                "type": "string"
                              }
                            }
                          },
                          "required": [
                            "key",
                            "text",
                            "choices"
                          ],
                          "additionalProperties": false
                        }
                      ],
                      "minItems": 1,
                      "items": {
                        "type": "object",
                        "properties": {
                          "key": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string",
                            "minLength": 1
                          },
                          "choices": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "required": [
                          "key",
                          "text",
                          "choices"
                        ],
                        "additionalProperties": false
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "questions"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "secret"
                    },
                    "slot": {
                      "type": "string"
                    },
                    "purpose": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "toolOnce"
                            },
                            "tool": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "required": [
                            "kind",
                            "tool"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "commandFile"
                            },
                            "tool": {
                              "type": "string",
                              "minLength": 1
                            },
                            "commandId": {
                              "$ref": "#/$defs/CommandId"
                            }
                          },
                          "required": [
                            "kind",
                            "tool",
                            "commandId"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "slot"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "state": {
              "$ref": "#/$defs/TodoState"
            }
          },
          "required": [
            "id",
            "body",
            "state"
          ],
          "additionalProperties": false
        },
        "openedAt": {
          "$ref": "#/$defs/SyncPosition"
        }
      },
      "required": [
        "kind",
        "threadId",
        "request",
        "openedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "roundEnded"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "round": {
          "type": "object",
          "properties": {
            "id": {
              "$ref": "#/$defs/RoundId"
            },
            "attempt": {
              "type": "object",
              "properties": {
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "deliveryId": {
                  "$ref": "#/$defs/DeliveryId"
                },
                "phase": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "finished"
                        },
                        "root": {
                          "$ref": "#/$defs/NativeRoot"
                        },
                        "receipt": {
                          "anyOf": [
                            {
                              "$ref": "#/$defs/ReceiptProof"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "endedAt": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "endTimeEvidence": {
                          "$ref": "#/$defs/RoundEndTimeEvidence"
                        },
                        "nativeReason": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "captureId": {
                          "$ref": "#/$defs/CaptureId"
                        }
                      },
                      "required": [
                        "kind",
                        "root",
                        "receipt",
                        "endedAt",
                        "captureId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "endedEarly"
                        },
                        "root": {
                          "$ref": "#/$defs/NativeRoot"
                        },
                        "receipt": {
                          "anyOf": [
                            {
                              "$ref": "#/$defs/ReceiptProof"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "endedAt": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "endTimeEvidence": {
                          "$ref": "#/$defs/RoundEndTimeEvidence"
                        },
                        "nativeReason": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "reason": {
                          "enum": [
                            "failed",
                            "stopped",
                            "lost",
                            "superseded",
                            "unknown"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "root",
                        "receipt",
                        "endedAt",
                        "reason"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "required": [
                "attemptId",
                "deliveryId",
                "phase"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "id",
            "attempt"
          ],
          "additionalProperties": false
        },
        "changedAt": {
          "type": "string",
          "pattern": "^(0|[1-9][0-9]*)$",
          "description": "Occurrence position. For a terminal attempt this is the original end position, including after later receipt or capture updates."
        },
        "quota": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "resetAt": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "resetAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "review": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "enum": [
                    "plan",
                    "work"
                  ],
                  "type": "string"
                },
                "deferredAtEnd": {
                  "type": "boolean"
                }
              },
              "required": [
                "kind",
                "deferredAtEnd"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "readThrough": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncPosition"
            },
            {
              "type": "null"
            }
          ]
        },
        "grouping": {
          "enum": [
            "ordinary",
            "settled",
            "archived"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "threadId",
        "round",
        "changedAt",
        "quota",
        "review",
        "readThrough",
        "grouping"
      ],
      "additionalProperties": false
    }
  ]
}
```

## AttentionRead

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "selection": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "current"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "object"
            },
            "databaseGeneration": {
              "type": "string",
              "minLength": 1
            },
            "object": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "request"
                    },
                    "requestId": {
                      "$ref": "#/$defs/TodoRequestId"
                    }
                  },
                  "required": [
                    "kind",
                    "requestId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "round"
                    },
                    "roundId": {
                      "$ref": "#/$defs/RoundId"
                    },
                    "attemptId": {
                      "$ref": "#/$defs/AttemptId"
                    }
                  },
                  "required": [
                    "kind",
                    "roundId",
                    "attemptId"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "kind",
            "databaseGeneration",
            "object"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "since"
            },
            "installed": {
              "$ref": "#/$defs/SyncCursor"
            },
            "through": {
              "$ref": "#/$defs/SyncCursor"
            },
            "after": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "position": {
                      "$ref": "#/$defs/SyncPosition"
                    },
                    "threadId": {
                      "$ref": "#/$defs/ThreadId"
                    },
                    "object": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "request"
                            },
                            "requestId": {
                              "$ref": "#/$defs/TodoRequestId"
                            }
                          },
                          "required": [
                            "kind",
                            "requestId"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "round"
                            },
                            "roundId": {
                              "$ref": "#/$defs/RoundId"
                            },
                            "attemptId": {
                              "$ref": "#/$defs/AttemptId"
                            }
                          },
                          "required": [
                            "kind",
                            "roundId",
                            "attemptId"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "required": [
                    "position",
                    "threadId",
                    "object"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "kind",
            "installed",
            "through",
            "after"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "threadId",
    "selection"
  ],
  "additionalProperties": false
}
```

## AttentionThread

```json
{
  "type": "object",
  "properties": {
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "databaseGeneration": {
      "type": "string",
      "minLength": 1
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    }
  },
  "required": [
    "ownerId",
    "environmentId",
    "databaseGeneration",
    "threadId"
  ],
  "additionalProperties": false
}
```

## AuthorizationFailure

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "missingPermission"
        },
        "permission": {
          "$ref": "#/$defs/PermissionItem"
        },
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        }
      },
      "required": [
        "kind",
        "permission",
        "target"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "permissionLimited"
        },
        "permission": {
          "$ref": "#/$defs/PermissionItem"
        },
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "requestedMode": {
          "$ref": "#/$defs/PermissionMode"
        },
        "effectiveMode": {
          "$ref": "#/$defs/PermissionMode"
        },
        "limitedBy": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "device"
                },
                "deviceId": {
                  "$ref": "#/$defs/DeviceId"
                },
                "principalId": {
                  "$ref": "#/$defs/PrincipalId"
                }
              },
              "required": [
                "kind",
                "deviceId",
                "principalId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "administrator"
                },
                "policyId": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "policyId"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "permission",
        "target",
        "requestedMode",
        "effectiveMode",
        "limitedBy"
      ],
      "additionalProperties": false
    }
  ]
}
```

## AuthorizationTarget

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "environment"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "kind",
        "environmentId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "project"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        }
      },
      "required": [
        "kind",
        "projectId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "thread"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "threadId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## BrowserProfile

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "host": {
      "$ref": "#/$defs/PreviewHost"
    },
    "profileId": {
      "$ref": "#/$defs/BrowserProfileId"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 48
    },
    "storage": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "persistent"
            },
            "partition": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "partition"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "ephemeral"
            },
            "incognito": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "incognito"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "environmentId",
    "host",
    "profileId",
    "name",
    "storage"
  ],
  "additionalProperties": false
}
```

## BrowserProfileClearResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "cleared"
        },
        "profile": {
          "$ref": "#/$defs/BrowserProfileIdentity"
        }
      },
      "required": [
        "kind",
        "profile"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unsupported"
        },
        "profile": {
          "$ref": "#/$defs/BrowserProfileIdentity"
        }
      },
      "required": [
        "kind",
        "profile"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "failed"
        },
        "profile": {
          "$ref": "#/$defs/BrowserProfileIdentity"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "profile",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## BrowserProfileId

```json
{
  "type": "string",
  "minLength": 1
}
```

## BrowserProfileIdentity

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "host": {
      "$ref": "#/$defs/PreviewHost"
    },
    "profileId": {
      "$ref": "#/$defs/BrowserProfileId"
    }
  },
  "required": [
    "environmentId",
    "host",
    "profileId"
  ],
  "additionalProperties": false
}
```

## BrowserProfiles

```json
{
  "type": "array",
  "items": {
    "$ref": "#/$defs/BrowserProfile"
  },
  "maxItems": 24
}
```

## CapabilityMatrix

```json
{
  "type": "object",
  "properties": {
    "startSession": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "resumeSessionAfterProcessExit": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "resumeSessionAfterHostRestart": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "submitTextInput": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "submitImageInput": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "submitFileInput": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "streamResponse": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "exposeReasoning": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportToolActivity": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportRoundEnd": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportFileChanges": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "updatePlan": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "stopRound": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "steerCurrentRound": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "queueNextInput": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "steerCurrentWithAttachments": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "requestCommandApproval": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "requestFileApproval": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "askStructuredQuestion": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "answerApprovalChoices": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "answerAfterDisconnect": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "selectPermissionMode": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "changePermissionDuringRun": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "declareSandboxEnforcement": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "forkAtRound": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "rollbackRounds": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "compactContext": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "clearSession": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "readHistory": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportChildWork": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "isolateAccounts": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "checkAuthentication": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "startLogin": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "listModels": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "changeModel": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "setModelOptions": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportTokenUsage": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportQuota": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "reportCost": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "classifyErrors": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "declareTransport": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "negotiateProtocol": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "declareTerms": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "provideTools": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "configureWorkspace": {
      "$ref": "#/$defs/CapabilitySupport"
    },
    "configureEnvironment": {
      "$ref": "#/$defs/CapabilitySupport"
    }
  },
  "required": [
    "startSession",
    "resumeSessionAfterProcessExit",
    "resumeSessionAfterHostRestart",
    "submitTextInput",
    "submitImageInput",
    "submitFileInput",
    "streamResponse",
    "exposeReasoning",
    "reportToolActivity",
    "reportRoundEnd",
    "reportFileChanges",
    "updatePlan",
    "stopRound",
    "steerCurrentRound",
    "queueNextInput",
    "steerCurrentWithAttachments",
    "requestCommandApproval",
    "requestFileApproval",
    "askStructuredQuestion",
    "answerApprovalChoices",
    "answerAfterDisconnect",
    "selectPermissionMode",
    "changePermissionDuringRun",
    "declareSandboxEnforcement",
    "forkAtRound",
    "rollbackRounds",
    "compactContext",
    "clearSession",
    "readHistory",
    "reportChildWork",
    "isolateAccounts",
    "checkAuthentication",
    "startLogin",
    "listModels",
    "changeModel",
    "setModelOptions",
    "reportTokenUsage",
    "reportQuota",
    "reportCost",
    "classifyErrors",
    "declareTransport",
    "negotiateProtocol",
    "declareTerms",
    "provideTools",
    "configureWorkspace",
    "configureEnvironment"
  ],
  "additionalProperties": false
}
```

## CapabilitySupport

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "native"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "substitute"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unsupported"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## CaptureId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ChangeSummary

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unknown"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "empty"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "changed"
        },
        "fileCount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "fileCount"
      ],
      "additionalProperties": false
    }
  ]
}
```

## CheckoutResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "available"
        },
        "binding": {
          "$ref": "#/$defs/DirectoryBinding"
        },
        "path": {
          "type": "string",
          "minLength": 1
        },
        "shared": {
          "type": "boolean"
        }
      },
      "required": [
        "kind",
        "binding",
        "path",
        "shared"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unavailable"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## CheckpointCapture

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/CaptureId"
    },
    "roundId": {
      "$ref": "#/$defs/RoundId"
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "result": {
      "$ref": "#/$defs/CheckpointResult"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "roundId",
    "attemptId",
    "result",
    "version"
  ],
  "additionalProperties": false
}
```

## CheckpointComparison

```json
{
  "type": "object",
  "properties": {
    "before": {
      "$ref": "#/$defs/GitObjectId"
    },
    "after": {
      "$ref": "#/$defs/GitObjectId"
    },
    "summary": {
      "$ref": "#/$defs/ChangeSummary"
    }
  },
  "required": [
    "before",
    "after",
    "summary"
  ],
  "additionalProperties": false
}
```

## CheckpointResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "ready"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "comparison": {
          "$ref": "#/$defs/CheckpointComparison"
        }
      },
      "required": [
        "kind",
        "worktreeId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "missing"
        },
        "boundary": {
          "enum": [
            "before",
            "after"
          ],
          "type": "string"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "error"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "boundary": {
          "enum": [
            "before",
            "after"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ChildLaunch

```json
{
  "type": "object",
  "properties": {
    "childCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    },
    "checkout": {
      "enum": [
        "shared",
        "isolated"
      ],
      "type": "string"
    },
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "model": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "options": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              }
            ]
          }
        }
      },
      "required": [
        "id",
        "options"
      ],
      "additionalProperties": false
    },
    "requestedMode": {
      "$ref": "#/$defs/PermissionMode"
    }
  },
  "required": [
    "childCommandId",
    "projectId",
    "instruction",
    "checkout"
  ],
  "additionalProperties": false
}
```

## ChildReceipt

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "accepted"
        },
        "taskId": {
          "$ref": "#/$defs/ChildTaskId"
        },
        "childCommandId": {
          "$ref": "#/$defs/CommandId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        }
      },
      "required": [
        "kind",
        "taskId",
        "childCommandId",
        "threadId",
        "roundId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "rejected"
        },
        "childCommandId": {
          "$ref": "#/$defs/CommandId"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "childCommandId",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ChildResultTransfer

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/ChildResultTransferId"
    },
    "taskId": {
      "$ref": "#/$defs/ChildTaskId"
    },
    "parentThreadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "parentRoundId": {
      "$ref": "#/$defs/RoundId"
    },
    "childThreadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "childRoundId": {
      "$ref": "#/$defs/RoundId"
    },
    "result": {
      "type": "string"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "pending"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "returned"
            },
            "parentMessageId": {
              "$ref": "#/$defs/MessageId"
            },
            "returnedAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "kind",
            "parentMessageId",
            "returnedAt"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "id",
    "taskId",
    "parentThreadId",
    "parentRoundId",
    "childThreadId",
    "childRoundId",
    "result",
    "version",
    "state"
  ],
  "additionalProperties": false
}
```

## ChildResultTransferId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ChildStatus

```json
{
  "type": "object",
  "properties": {
    "taskId": {
      "$ref": "#/$defs/ChildTaskId"
    },
    "childCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "queued",
                "working",
                "cancelled"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "waitingApproval"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            },
            "requestId": {
              "$ref": "#/$defs/TodoRequestId"
            }
          },
          "required": [
            "kind",
            "roundId",
            "requestId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "completed"
            },
            "result": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "result"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "failed"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "taskId",
    "childCommandId",
    "threadId",
    "state"
  ],
  "additionalProperties": false
}
```

## ChildTaskId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ClientAuthentication

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "client.authenticate"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "clientNonce": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "features": {
      "$ref": "#/$defs/ProtocolFeatureSet"
    },
    "method": {
      "const": "session.authenticate"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "clientNonce",
    "signer",
    "sequence",
    "features",
    "method",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Signs the UTF-8 canonical JSON of every field except signature. The server must verify the challenge and client nonce on this connection."
}
```

## CommandId

```json
{
  "type": "string",
  "minLength": 1
}
```

## CommandReceipt

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "accepted"
        },
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "result": {
          "oneOf": [
            {
              "$ref": "#/$defs/ToolActivityReadResult"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "stopResult"
                },
                "stopCommandId": {
                  "$ref": "#/$defs/CommandId"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "roundId": {
                  "$ref": "#/$defs/RoundId"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "instanceId": {
                  "$ref": "#/$defs/ExecutorInstanceId"
                },
                "epoch": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "sessionId": {
                  "$ref": "#/$defs/NativeSessionId"
                },
                "rootId": {
                  "$ref": "#/$defs/NativeRootTurnId"
                },
                "requestedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "dispatchedAt": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reachedAt": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "timedOutAt": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "disposition": {
                  "enum": [
                    "pending",
                    "unconfirmed",
                    "stopped",
                    "alreadyEnded"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "stopCommandId",
                "threadId",
                "roundId",
                "attemptId",
                "instanceId",
                "epoch",
                "sessionId",
                "rootId",
                "requestedAt",
                "dispatchedAt",
                "reachedAt",
                "timedOutAt",
                "disposition"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "executorRefreshed"
                },
                "instanceId": {
                  "$ref": "#/$defs/ExecutorInstanceId"
                },
                "configurationVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                },
                "snapshot": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ExecutorInstanceSnapshot"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "readiness": {
                  "type": "object",
                  "properties": {
                    "configured": {
                      "type": "object",
                      "properties": {
                        "state": {
                          "enum": [
                            "yes",
                            "no",
                            "unknown"
                          ],
                          "type": "string"
                        },
                        "verifiedAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "state",
                        "verifiedAt"
                      ],
                      "additionalProperties": false
                    },
                    "installed": {
                      "type": "object",
                      "properties": {
                        "state": {
                          "enum": [
                            "yes",
                            "no",
                            "unknown"
                          ],
                          "type": "string"
                        },
                        "verifiedAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "state",
                        "verifiedAt"
                      ],
                      "additionalProperties": false
                    },
                    "authenticated": {
                      "type": "object",
                      "properties": {
                        "state": {
                          "enum": [
                            "yes",
                            "no",
                            "unknown"
                          ],
                          "type": "string"
                        },
                        "verifiedAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "state",
                        "verifiedAt"
                      ],
                      "additionalProperties": false
                    },
                    "model": {
                      "type": "object",
                      "properties": {
                        "state": {
                          "enum": [
                            "yes",
                            "no",
                            "unknown"
                          ],
                          "type": "string"
                        },
                        "verifiedAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "state",
                        "verifiedAt"
                      ],
                      "additionalProperties": false
                    },
                    "operation": {
                      "type": "object",
                      "properties": {
                        "state": {
                          "enum": [
                            "yes",
                            "no",
                            "unknown"
                          ],
                          "type": "string"
                        },
                        "verifiedAt": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "state",
                        "verifiedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "configured",
                    "installed",
                    "authenticated",
                    "model",
                    "operation"
                  ],
                  "additionalProperties": false
                },
                "models": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "checkedAt": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "models": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "slug": {
                                "type": "string",
                                "minLength": 1
                              },
                              "displayName": {
                                "type": "string",
                                "minLength": 1
                              },
                              "isDefault": {
                                "type": "boolean"
                              },
                              "options": {
                                "type": "object",
                                "propertyNames": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "additionalProperties": {
                                  "anyOf": [
                                    {
                                      "type": "object",
                                      "properties": {
                                        "kind": {
                                          "const": "enum"
                                        },
                                        "values": {
                                          "type": "array",
                                          "items": {
                                            "type": "string",
                                            "minLength": 1
                                          }
                                        }
                                      },
                                      "required": [
                                        "kind",
                                        "values"
                                      ],
                                      "additionalProperties": false
                                    },
                                    {
                                      "type": "object",
                                      "properties": {
                                        "kind": {
                                          "enum": [
                                            "boolean",
                                            "number",
                                            "string"
                                          ],
                                          "type": "string"
                                        }
                                      },
                                      "required": [
                                        "kind"
                                      ],
                                      "additionalProperties": false
                                    }
                                  ]
                                }
                              },
                              "unavailableReason": {
                                "type": "string",
                                "minLength": 1
                              }
                            },
                            "required": [
                              "id",
                              "slug",
                              "displayName",
                              "isDefault",
                              "options"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "checkedAt",
                        "models"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "binaryVersion": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "variables": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "name": {
                        "type": "string",
                        "minLength": 1
                      },
                      "kind": {
                        "enum": [
                          "secret",
                          "literal"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "name",
                      "kind"
                    ],
                    "additionalProperties": false
                  }
                },
                "compatibilityAdvisory": {
                  "anyOf": [
                    {
                      "enum": [
                        "broken",
                        "unsupported"
                      ],
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "versionAdvisory": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "instanceId",
                "configurationVersion",
                "snapshot",
                "readiness",
                "models",
                "binaryVersion",
                "variables",
                "compatibilityAdvisory",
                "versionAdvisory"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "executorConfigured"
                },
                "instanceId": {
                  "$ref": "#/$defs/ExecutorInstanceId"
                },
                "version": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "kind",
                "instanceId",
                "version"
              ],
              "additionalProperties": false
            },
            {
              "$ref": "#/$defs/ContextOperationReceipt"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "projectRegistered"
                },
                "project": {
                  "$ref": "#/$defs/Project"
                }
              },
              "required": [
                "kind",
                "project"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "threadRenamed"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "version": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "kind",
                "threadId",
                "version"
              ],
              "additionalProperties": false
            },
            {
              "$ref": "#/$defs/TextReturnResult"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "grantsListed"
                },
                "grants": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/PermissionGrant"
                  }
                },
                "next": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "grants",
                "next"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accessChangesListed"
                },
                "changes": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/AccessChange"
                  }
                },
                "next": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "changes",
                "next"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "invitesListed"
                },
                "invites": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/UnusedInvite"
                  }
                },
                "next": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "invites",
                "next"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "applicationsListed"
                },
                "applications": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/PairingPending"
                  }
                },
                "next": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "applications",
                "next"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "inviteCancelled"
                },
                "inviteId": {
                  "$ref": "#/$defs/PairingInviteId"
                }
              },
              "required": [
                "kind",
                "inviteId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "earlierSettled"
                },
                "page": {
                  "$ref": "#/$defs/EarlierSettledPage"
                }
              },
              "required": [
                "kind",
                "page"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "threadChanged"
                },
                "summary": {
                  "$ref": "#/$defs/ThreadSummary"
                }
              },
              "required": [
                "kind",
                "summary"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "queueUpdated"
                },
                "update": {
                  "$ref": "#/$defs/QueueUpdate"
                }
              },
              "required": [
                "kind",
                "update"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "gitStatus"
                },
                "snapshot": {
                  "$ref": "#/$defs/GitStatus"
                }
              },
              "required": [
                "kind",
                "snapshot"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "directoryListed"
                },
                "directory": {
                  "$ref": "#/$defs/WorkspaceDirectory"
                }
              },
              "required": [
                "kind",
                "directory"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "fileRead"
                },
                "file": {
                  "$ref": "#/$defs/WorkspaceFileRead"
                }
              },
              "required": [
                "kind",
                "file"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "fileWritten"
                },
                "write": {
                  "$ref": "#/$defs/WorkspaceWriteResult"
                }
              },
              "required": [
                "kind",
                "write"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "workspaceMatches"
                },
                "search": {
                  "$ref": "#/$defs/WorkspaceSearchResult"
                }
              },
              "required": [
                "kind",
                "search"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "secretReceipt"
                },
                "receipt": {
                  "$ref": "#/$defs/SecretReceipt"
                }
              },
              "required": [
                "kind",
                "receipt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkoutObserved"
                },
                "checkout": {
                  "$ref": "#/$defs/CheckoutResult"
                }
              },
              "required": [
                "kind",
                "checkout"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "childrenAccepted"
                },
                "items": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/ChildReceipt"
                  }
                }
              },
              "required": [
                "kind",
                "items"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "childStatus"
                },
                "child": {
                  "$ref": "#/$defs/ChildStatus"
                }
              },
              "required": [
                "kind",
                "child"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "childResultTransfer"
                },
                "transfer": {
                  "$ref": "#/$defs/ChildResultTransfer"
                }
              },
              "required": [
                "kind",
                "transfer"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "appCallback"
                },
                "result": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "completed"
                        },
                        "contentJson": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "contentJson"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "enum": [
                            "sessionStopped",
                            "toolNotCallable",
                            "resourceUnavailable",
                            "confirmationRequired",
                            "unknown"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "result"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "appConfirmed"
                },
                "confirmation": {
                  "$ref": "#/$defs/AppConfirmation"
                }
              },
              "required": [
                "kind",
                "confirmation"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "appNoteChanged"
                },
                "note": {
                  "$ref": "#/$defs/AppNote"
                }
              },
              "required": [
                "kind",
                "note"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "forgeOperation"
                },
                "operation": {
                  "$ref": "#/$defs/ForgeProgress"
                }
              },
              "required": [
                "kind",
                "operation"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "forgeFileReading"
                },
                "reading": {
                  "$ref": "#/$defs/ForgeMarkView"
                }
              },
              "required": [
                "kind",
                "reading"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "forgeHistory"
                },
                "history": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/ForgeHistory"
                  }
                }
              },
              "required": [
                "kind",
                "history"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkpointDiff"
                },
                "diff": {
                  "$ref": "#/$defs/DiffResult"
                }
              },
              "required": [
                "kind",
                "diff"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkpointRollback"
                },
                "progress": {
                  "$ref": "#/$defs/RollbackProgress"
                }
              },
              "required": [
                "kind",
                "progress"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "terminalControl"
                },
                "control": {
                  "$ref": "#/$defs/TerminalControl"
                }
              },
              "required": [
                "kind",
                "control"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "terminalSession"
                },
                "session": {
                  "$ref": "#/$defs/TerminalSession"
                }
              },
              "required": [
                "kind",
                "session"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "terminalInput"
                },
                "receipt": {
                  "$ref": "#/$defs/TerminalInputReceipt"
                }
              },
              "required": [
                "kind",
                "receipt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "worktreeBaseSelected"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                },
                "branch": {
                  "type": "string",
                  "minLength": 1
                },
                "baseRef": {
                  "type": "string",
                  "minLength": 1
                },
                "commit": {
                  "$ref": "#/$defs/GitObjectId"
                }
              },
              "required": [
                "kind",
                "projectId",
                "worktreeId",
                "branch",
                "baseRef",
                "commit"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "worktreeStatus"
                },
                "view": {
                  "$ref": "#/$defs/WorktreeView"
                }
              },
              "required": [
                "kind",
                "view"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "worktreeRetained"
                },
                "view": {
                  "$ref": "#/$defs/WorktreeView"
                },
                "reason": {
                  "$ref": "#/$defs/WorktreeRetained"
                }
              },
              "required": [
                "kind",
                "view",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "settingRead"
                },
                "readback": {
                  "$ref": "#/$defs/SettingReadback"
                }
              },
              "required": [
                "kind",
                "readback"
              ],
              "additionalProperties": false
            },
            {
              "$ref": "#/$defs/SettingSaved"
            },
            {
              "$ref": "#/$defs/AttentionHistory"
            },
            {
              "$ref": "#/$defs/AttentionObject"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "attentionFacts"
                },
                "facts": {
                  "$ref": "#/$defs/AttentionFacts"
                }
              },
              "required": [
                "kind",
                "facts"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "threadStarted"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "messageId": {
                  "$ref": "#/$defs/MessageId"
                },
                "roundId": {
                  "$ref": "#/$defs/RoundId"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "deliveryId": {
                  "$ref": "#/$defs/DeliveryId"
                }
              },
              "required": [
                "kind",
                "threadId",
                "messageId",
                "roundId",
                "attemptId",
                "deliveryId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "inputScheduled"
                },
                "messageId": {
                  "$ref": "#/$defs/MessageId"
                },
                "roundId": {
                  "$ref": "#/$defs/RoundId"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "deliveryId": {
                  "$ref": "#/$defs/DeliveryId"
                }
              },
              "required": [
                "kind",
                "messageId",
                "roundId",
                "attemptId",
                "deliveryId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "actionAccepted"
                },
                "supportedFields": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "todoAnswerRead"
                },
                "todoRequestId": {
                  "$ref": "#/$defs/TodoRequestId"
                },
                "messageId": {
                  "$ref": "#/$defs/MessageId"
                },
                "authorId": {
                  "$ref": "#/$defs/PrincipalId"
                },
                "deviceId": {
                  "$ref": "#/$defs/DeviceId"
                },
                "at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "content": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "question"
                        },
                        "answers": {
                          "type": "array",
                          "prefixItems": [
                            {
                              "type": "object",
                              "properties": {
                                "questionKey": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 256
                                },
                                "answer": {
                                  "type": "string",
                                  "maxLength": 8192
                                }
                              },
                              "required": [
                                "questionKey",
                                "answer"
                              ],
                              "additionalProperties": false
                            }
                          ],
                          "minItems": 1,
                          "items": {
                            "type": "object",
                            "properties": {
                              "questionKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "answer": {
                                "type": "string",
                                "maxLength": 8192
                              }
                            },
                            "required": [
                              "questionKey",
                              "answer"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "kind",
                        "answers"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "approval"
                        },
                        "choiceKey": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 256
                        },
                        "decision": {
                          "enum": [
                            "allow",
                            "deny",
                            "allowEdited"
                          ],
                          "type": "string"
                        },
                        "scope": {
                          "enum": [
                            "once",
                            "session",
                            "project",
                            "persistent"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "choiceKey",
                        "decision",
                        "scope"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "todoRequestId",
                "messageId",
                "authorId",
                "deviceId",
                "at",
                "content"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "todoAnswerStored"
                },
                "todoRequestId": {
                  "$ref": "#/$defs/TodoRequestId"
                }
              },
              "required": [
                "kind",
                "todoRequestId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accessChanged"
                },
                "grantId": {
                  "$ref": "#/$defs/AccessGrantId"
                }
              },
              "required": [
                "kind",
                "grantId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "pairingInvited"
                },
                "inviteId": {
                  "$ref": "#/$defs/PairingInviteId"
                },
                "expiresAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "inviteId",
                "expiresAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "sessionsListed"
                },
                "sessions": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "sessionId": {
                        "$ref": "#/$defs/EnvironmentSessionId"
                      },
                      "connectionId": {
                        "$ref": "#/$defs/ConnectionId"
                      },
                      "principal": {
                        "$ref": "#/$defs/ActivePrincipal"
                      },
                      "signer": {
                        "oneOf": [
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "const": "device"
                              },
                              "deviceId": {
                                "$ref": "#/$defs/DeviceId"
                              },
                              "keyId": {
                                "$ref": "#/$defs/DeviceKeyId"
                              }
                            },
                            "required": [
                              "kind",
                              "deviceId",
                              "keyId"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "const": "executor"
                              },
                              "principalId": {
                                "$ref": "#/$defs/PrincipalId"
                              },
                              "keyId": {
                                "$ref": "#/$defs/ExecutorKeyId"
                              }
                            },
                            "required": [
                              "kind",
                              "principalId",
                              "keyId"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "authorizedAt": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "required": [
                      "sessionId",
                      "connectionId",
                      "principal",
                      "signer",
                      "authorizedAt"
                    ],
                    "additionalProperties": false
                  }
                }
              },
              "required": [
                "kind",
                "sessions"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "subscriptionOpened"
                },
                "subscriptionId": {
                  "$ref": "#/$defs/SubscriptionId"
                },
                "streamId": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
                }
              },
              "required": [
                "kind",
                "subscriptionId",
                "streamId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "contentTransferOpened"
                },
                "transferId": {
                  "$ref": "#/$defs/ContentTransferId"
                },
                "streamId": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
                }
              },
              "required": [
                "kind",
                "transferId",
                "streamId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "historyReadStarted"
                },
                "streamId": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
                }
              },
              "required": [
                "kind",
                "streamId"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "commandId",
        "result"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "rejected"
        },
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "failure": {
          "anyOf": [
            {
              "$ref": "#/$defs/AuthorizationFailure"
            },
            {
              "$ref": "#/$defs/QueueConflict"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "worktreeRestoreFailed"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                },
                "generation": {
                  "$ref": "#/$defs/WorktreeGeneration"
                },
                "reason": {
                  "enum": [
                    "sourceUnavailable",
                    "ownershipUnconfirmed",
                    "setupFailed"
                  ],
                  "type": "string"
                },
                "view": {
                  "$ref": "#/$defs/WorktreeView"
                }
              },
              "required": [
                "kind",
                "threadId",
                "worktreeId",
                "generation",
                "reason",
                "view"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "threadVersionConflict"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "currentVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "kind",
                "threadId",
                "currentVersion"
              ],
              "additionalProperties": false
            },
            {
              "$ref": "#/$defs/SettingWriteFailure"
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "todoChanged"
                },
                "current": {
                  "$ref": "#/$defs/TodoRequest"
                }
              },
              "required": [
                "kind",
                "current"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "enum": [
                    "unsupported",
                    "notFound",
                    "crossRepository",
                    "invalidState",
                    "idConflict",
                    "expired",
                    "queueHeld",
                    "notQueueHead",
                    "unsafeToRetry",
                    "cursorExpired",
                    "staleSequence",
                    "invalidProof"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "commandId",
        "failure"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "programError"
        },
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "code": {
          "const": "internalError"
        }
      },
      "required": [
        "kind",
        "commandId",
        "code"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ConnectionChallenge

```json
{
  "type": "string",
  "minLength": 43,
  "maxLength": 43,
  "pattern": "^[A-Za-z0-9_-]+$",
  "description": "32 random bytes encoded as unpadded base64url."
}
```

## ConnectionChallengeId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ConnectionId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ContentChunkHeader

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "content.chunk"
    },
    "transferId": {
      "$ref": "#/$defs/ContentTransferId"
    },
    "offsetBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "byteLength": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1024
    },
    "payloadEncoding": {
      "const": "binary"
    }
  },
  "required": [
    "kind",
    "transferId",
    "offsetBytes",
    "byteLength",
    "payloadEncoding"
  ],
  "additionalProperties": false,
  "description": "The following binary payload has byteLength raw bytes. The complete WebSocket message, including its JSON header, is limited by TransportLimits.maxDataChunkBytes."
}
```

## ContentTransferId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ContextOperation

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "deliveryId": {
          "$ref": "#/$defs/DeliveryId"
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "action": {
          "const": "compact"
        },
        "state": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accepted"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt",
                "observedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "completed"
                },
                "completedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "summary": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "firstKeptEntryId": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "completedAt",
                "summary",
                "firstKeptEntryId",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "failedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "failedAt",
                "reason",
                "acceptedAt"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "threadId",
        "deliveryId",
        "version",
        "action",
        "state"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "deliveryId": {
          "$ref": "#/$defs/DeliveryId"
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "action": {
          "const": "clear"
        },
        "state": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accepted"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt",
                "observedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "completed"
                },
                "completedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "nativeSessionId": {
                  "$ref": "#/$defs/NativeSessionId"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "completedAt",
                "nativeSessionId",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "failedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "failedAt",
                "reason",
                "acceptedAt"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "threadId",
        "deliveryId",
        "version",
        "action",
        "state"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ContextOperationObservation

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "action": {
          "const": "compact"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "deliveryId": {
          "$ref": "#/$defs/DeliveryId"
        },
        "state": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accepted"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "completed"
                },
                "completedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "summary": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "firstKeptEntryId": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "completedAt",
                "summary",
                "firstKeptEntryId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "failedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "failedAt",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                },
                "observedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "observedAt"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "action",
        "threadId",
        "deliveryId",
        "state"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "const": "clear"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "deliveryId": {
          "$ref": "#/$defs/DeliveryId"
        },
        "state": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "accepted"
                },
                "acceptedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "acceptedAt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "completed"
                },
                "completedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "nativeSessionId": {
                  "$ref": "#/$defs/NativeSessionId"
                }
              },
              "required": [
                "kind",
                "completedAt",
                "nativeSessionId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "failedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "failedAt",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                },
                "observedAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "observedAt"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "action",
        "threadId",
        "deliveryId",
        "state"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ContextOperationReceipt

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "contextOperation"
    },
    "operation": {
      "$ref": "#/$defs/ContextOperation"
    }
  },
  "required": [
    "kind",
    "operation"
  ],
  "additionalProperties": false
}
```

## ContextTransferId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ControlMessage

```json
{
  "anyOf": [
    {
      "$ref": "#/$defs/TerminalGap"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "terminal.state"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "session": {
          "$ref": "#/$defs/TerminalSession"
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "session"
      ],
      "additionalProperties": false
    },
    {
      "$ref": "#/$defs/ServerHello"
    },
    {
      "$ref": "#/$defs/ClientAuthentication"
    },
    {
      "$ref": "#/$defs/SessionAuthorized"
    },
    {
      "$ref": "#/$defs/SessionConfiguration"
    },
    {
      "$ref": "#/$defs/SessionRejected"
    },
    {
      "$ref": "#/$defs/PairingRequest"
    },
    {
      "$ref": "#/$defs/PairingPending"
    },
    {
      "$ref": "#/$defs/PairingChallenge"
    },
    {
      "$ref": "#/$defs/PairingExchange"
    },
    {
      "$ref": "#/$defs/DevicePairingResult"
    },
    {
      "$ref": "#/$defs/SignedRequest"
    },
    {
      "$ref": "#/$defs/CommandReceipt"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "transport.content"
        },
        "transferId": {
          "$ref": "#/$defs/ContentTransferId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "byteLength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "encoding": {
          "const": "utf8Json"
        }
      },
      "required": [
        "kind",
        "transferId",
        "streamId",
        "byteLength",
        "encoding"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "transport.probe"
        },
        "serial": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "serial"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "transport.echo"
        },
        "serial": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "serial"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "stream.reset"
        },
        "streamId": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "reason": {
          "enum": [
            "cancelled",
            "unknownStream",
            "overloaded",
            "contentChanged"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "streamId",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "subscription.begin"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "passId": {
          "$ref": "#/$defs/SyncPassId"
        },
        "base": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncCursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "through": {
          "$ref": "#/$defs/SyncCursor"
        },
        "mode": {
          "enum": [
            "replace",
            "merge"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "passId",
        "base",
        "through",
        "mode"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "subscription.reset"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "reason": {
          "enum": [
            "cursorExpired",
            "rangeChanged",
            "authorizationChanged",
            "databaseGenerationChanged",
            "shapeChanged"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "subscription.seal"
        },
        "pages": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "passId": {
          "$ref": "#/$defs/SyncPassId"
        },
        "cursor": {
          "$ref": "#/$defs/SyncCursor"
        }
      },
      "required": [
        "kind",
        "pages",
        "subscriptionId",
        "passId",
        "cursor"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "subscription.ended"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "reason": {
          "enum": [
            "clientClosed",
            "authorizationRevoked",
            "backlogExceeded",
            "acknowledgementTimeout"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DataMessage

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "git.status"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "snapshot": {
          "$ref": "#/$defs/GitStatus"
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "snapshot"
      ],
      "additionalProperties": false
    },
    {
      "$ref": "#/$defs/TerminalSnapshot"
    },
    {
      "$ref": "#/$defs/TerminalOutput"
    },
    {
      "$ref": "#/$defs/SubscriptionPage"
    },
    {
      "$ref": "#/$defs/HistoryPage"
    },
    {
      "$ref": "#/$defs/ToolActivityDetailFrame"
    },
    {
      "$ref": "#/$defs/ContentChunkHeader"
    }
  ]
}
```

## DelegatedChildRecord

```json
{
  "type": "object",
  "properties": {
    "taskId": {
      "$ref": "#/$defs/ChildTaskId"
    },
    "parentThreadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "parentRoundId": {
      "$ref": "#/$defs/RoundId"
    },
    "childCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "childThreadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "childRoundId": {
      "$ref": "#/$defs/RoundId"
    },
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "model": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "options": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              }
            ]
          }
        }
      },
      "required": [
        "id",
        "options"
      ],
      "additionalProperties": false
    },
    "requestedMode": {
      "$ref": "#/$defs/PermissionMode"
    },
    "effectiveMode": {
      "$ref": "#/$defs/PermissionMode"
    },
    "returnTransferId": {
      "$ref": "#/$defs/ChildResultTransferId"
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "queued",
                "working",
                "cancelled"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "waitingApproval"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            },
            "requestId": {
              "$ref": "#/$defs/TodoRequestId"
            }
          },
          "required": [
            "kind",
            "roundId",
            "requestId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "completed"
            },
            "result": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "result"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "failed"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "taskId",
    "parentThreadId",
    "parentRoundId",
    "childCommandId",
    "childThreadId",
    "childRoundId",
    "instanceId",
    "model",
    "requestedMode",
    "effectiveMode",
    "returnTransferId",
    "state"
  ],
  "additionalProperties": false
}
```

## DeliveryId

```json
{
  "type": "string",
  "minLength": 1
}
```

## DesktopPortMapping

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/PortMappingId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "desktopInstanceId": {
      "$ref": "#/$defs/HostInstanceId"
    },
    "service": {
      "$ref": "#/$defs/PortService"
    },
    "localHost": {
      "const": "127.0.0.1"
    },
    "localPort": {
      "$ref": "#/$defs/PortNumber"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "active"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "closed"
            },
            "reason": {
              "enum": [
                "requested",
                "revoked",
                "serviceChanged",
                "desktopExited"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "id",
    "deviceId",
    "desktopInstanceId",
    "service",
    "localHost",
    "localPort",
    "createdAt",
    "state"
  ],
  "additionalProperties": false
}
```

## DeviceId

```json
{
  "type": "string",
  "minLength": 1
}
```

## DeviceKey

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/DeviceKeyId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "publicKey": {
      "$ref": "#/$defs/P256PublicKey"
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "usable"
            },
            "expiresAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "kind",
            "expiresAt"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "revoked"
            },
            "revokedAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "kind",
            "revokedAt"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "id",
    "deviceId",
    "publicKey",
    "state"
  ],
  "additionalProperties": false
}
```

## DeviceKeyId

```json
{
  "type": "string",
  "minLength": 1
}
```

## DevicePairingResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "pairing.completed"
        },
        "requestId": {
          "$ref": "#/$defs/PairingRequestId"
        },
        "principal": {
          "$ref": "#/$defs/DevicePrincipal"
        },
        "deviceKey": {
          "$ref": "#/$defs/DeviceKey"
        },
        "permissions": {
          "$ref": "#/$defs/PermissionSet"
        }
      },
      "required": [
        "kind",
        "requestId",
        "principal",
        "deviceKey",
        "permissions"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "pairing.rejected"
        },
        "requestId": {
          "$ref": "#/$defs/PairingRequestId"
        },
        "reason": {
          "enum": [
            "expired",
            "notSelected",
            "invalidProof",
            "cancelled",
            "alreadyExchanged"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "requestId",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DevicePrincipal

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "device"
    },
    "id": {
      "$ref": "#/$defs/PrincipalId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    }
  },
  "required": [
    "kind",
    "id",
    "deviceId",
    "ownerId"
  ],
  "additionalProperties": false
}
```

## DeviceRegistration

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "identity": {
          "$ref": "#/$defs/EnvironmentIdentity"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        },
        "keyId": {
          "$ref": "#/$defs/DeviceKeyId"
        },
        "publicKey": {
          "$ref": "#/$defs/P256PublicKey"
        },
        "target": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "project"
            },
            "projectId": {
              "$ref": "#/$defs/ProjectId"
            }
          },
          "required": [
            "kind",
            "projectId"
          ],
          "additionalProperties": false
        },
        "kind": {
          "const": "pendingExchange"
        },
        "inviteId": {
          "$ref": "#/$defs/PairingInviteId"
        },
        "requestId": {
          "$ref": "#/$defs/PairingRequestId"
        },
        "requestedPermissions": {
          "$ref": "#/$defs/PermissionSet"
        },
        "claimId": {
          "anyOf": [
            {
              "$ref": "#/$defs/PairingClaimId"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "identity",
        "deviceId",
        "keyId",
        "publicKey",
        "target",
        "kind",
        "inviteId",
        "requestId",
        "requestedPermissions",
        "claimId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "identity": {
          "$ref": "#/$defs/EnvironmentIdentity"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        },
        "keyId": {
          "$ref": "#/$defs/DeviceKeyId"
        },
        "publicKey": {
          "$ref": "#/$defs/P256PublicKey"
        },
        "target": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "project"
            },
            "projectId": {
              "$ref": "#/$defs/ProjectId"
            }
          },
          "required": [
            "kind",
            "projectId"
          ],
          "additionalProperties": false
        },
        "kind": {
          "const": "registered"
        },
        "principal": {
          "$ref": "#/$defs/DevicePrincipal"
        },
        "deviceKey": {
          "$ref": "#/$defs/DeviceKey"
        },
        "permissions": {
          "$ref": "#/$defs/PermissionSet"
        }
      },
      "required": [
        "identity",
        "deviceId",
        "keyId",
        "publicKey",
        "target",
        "kind",
        "principal",
        "deviceKey",
        "permissions"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DeviceSettingRow

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "fontSize"
        },
        "target": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            }
          },
          "required": [
            "kind",
            "deviceId"
          ],
          "additionalProperties": false
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 256
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DeviceSettingWrite

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "fontSize"
        },
        "target": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            }
          },
          "required": [
            "kind",
            "deviceId"
          ],
          "additionalProperties": false
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 256
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DialogueRollbackTarget

```json
{
  "anyOf": [
    {
      "$ref": "#/$defs/RollbackTarget"
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "worktreeId": {
          "type": "null"
        },
        "nativeSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "nativeRootTurnId": {
          "$ref": "#/$defs/NativeRootTurnId"
        },
        "boundary": {
          "enum": [
            "before",
            "after"
          ],
          "type": "string"
        }
      },
      "required": [
        "threadId",
        "roundId",
        "attemptId",
        "worktreeId",
        "nativeSessionId",
        "nativeRootTurnId",
        "boundary"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DiffEndpoint

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "git"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "relation": {
          "enum": [
            "mergeBase",
            "head",
            "firstParent",
            "commit",
            "emptyTree"
          ],
          "type": "string"
        },
        "oid": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "kind",
        "worktreeId",
        "relation",
        "oid"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "git"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "relation": {
          "enum": [
            "mergeBase",
            "head",
            "firstParent",
            "commit",
            "emptyTree"
          ],
          "type": "string"
        },
        "oid": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "kind",
        "threadId",
        "directoryId",
        "generation",
        "relation",
        "oid"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "workingTree"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "tree": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "kind",
        "worktreeId",
        "tree"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "workingTree"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "tree": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "kind",
        "threadId",
        "directoryId",
        "generation",
        "tree"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "round"
        },
        "captureId": {
          "$ref": "#/$defs/CaptureId"
        },
        "boundary": {
          "enum": [
            "before",
            "after"
          ],
          "type": "string"
        },
        "commit": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "kind",
        "captureId",
        "boundary",
        "commit"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DiffRequest

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "kind": {
          "const": "roundRange"
        },
        "fromCaptureId": {
          "$ref": "#/$defs/CaptureId"
        },
        "toCaptureId": {
          "$ref": "#/$defs/CaptureId"
        }
      },
      "required": [
        "threadId",
        "worktreeId",
        "kind",
        "fromCaptureId",
        "toCaptureId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "kind": {
          "const": "round"
        },
        "captureId": {
          "$ref": "#/$defs/CaptureId"
        }
      },
      "required": [
        "threadId",
        "worktreeId",
        "kind",
        "captureId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "kind": {
          "const": "workingTree"
        }
      },
      "required": [
        "threadId",
        "worktreeId",
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "kind": {
          "const": "workingTree"
        }
      },
      "required": [
        "threadId",
        "directoryId",
        "generation",
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "kind": {
          "const": "branch"
        },
        "baseRef": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "threadId",
        "worktreeId",
        "kind",
        "baseRef"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "kind": {
          "const": "branch"
        },
        "baseRef": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "threadId",
        "directoryId",
        "generation",
        "kind",
        "baseRef"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "kind": {
          "const": "commit"
        },
        "commit": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "threadId",
        "worktreeId",
        "kind",
        "commit"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "kind": {
          "const": "commit"
        },
        "commit": {
          "$ref": "#/$defs/GitObjectId"
        }
      },
      "required": [
        "threadId",
        "directoryId",
        "generation",
        "kind",
        "commit"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DiffResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "empty"
        },
        "from": {
          "$ref": "#/$defs/DiffEndpoint"
        },
        "to": {
          "$ref": "#/$defs/DiffEndpoint"
        }
      },
      "required": [
        "kind",
        "from",
        "to"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "changed"
        },
        "from": {
          "$ref": "#/$defs/DiffEndpoint"
        },
        "to": {
          "$ref": "#/$defs/DiffEndpoint"
        },
        "files": {
          "type": "array",
          "prefixItems": [
            {
              "$ref": "#/$defs/FileChange"
            }
          ],
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/FileChange"
          }
        },
        "patch": {
          "type": "string"
        },
        "truncated": {
          "type": "boolean"
        },
        "next": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "from",
        "to",
        "files",
        "patch",
        "next"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unavailable"
        },
        "request": {
          "$ref": "#/$defs/DiffRequest"
        },
        "from": {
          "anyOf": [
            {
              "$ref": "#/$defs/DiffEndpoint"
            },
            {
              "type": "null"
            }
          ]
        },
        "to": {
          "anyOf": [
            {
              "$ref": "#/$defs/DiffEndpoint"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "request",
        "from",
        "to",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DirectoryBinding

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "projectRoot"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        }
      },
      "required": [
        "kind",
        "directoryId",
        "generation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "managedWorktree"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "ownerThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "directoryId",
        "generation",
        "worktreeId",
        "ownerThreadId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "temporary"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "ownerThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "directoryId",
        "generation",
        "ownerThreadId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## DirectoryRecord

```json
{
  "type": "object",
  "properties": {
    "binding": {
      "$ref": "#/$defs/DirectoryBinding"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "realPath": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "binding",
    "projectId",
    "environmentId",
    "realPath"
  ],
  "additionalProperties": false
}
```

## EarlierSettledPage

```json
{
  "type": "object",
  "properties": {
    "through": {
      "$ref": "#/$defs/SyncCursor"
    },
    "threads": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "threadId": {
            "$ref": "#/$defs/ThreadId"
          },
          "projectId": {
            "$ref": "#/$defs/ProjectId"
          },
          "parentThreadId": {
            "anyOf": [
              {
                "$ref": "#/$defs/ThreadId"
              },
              {
                "type": "null"
              }
            ]
          },
          "version": {
            "$ref": "#/$defs/ObjectVersion"
          },
          "title": {
            "type": "string"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lastActivityAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lifecycle": {
            "type": "object",
            "properties": {
              "archivedAt": {
                "type": "null"
              },
              "state": {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "settled"
                  },
                  "at": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reason": {
                    "enum": [
                      "manual",
                      "idle",
                      "merged",
                      "closed"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "at",
                  "reason"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "archivedAt",
              "state"
            ],
            "additionalProperties": false
          },
          "openTodos": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "activeRounds": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "threadId",
          "projectId",
          "parentThreadId",
          "version",
          "title",
          "createdAt",
          "lastActivityAt",
          "lifecycle",
          "openTodos",
          "activeRounds"
        ],
        "additionalProperties": false
      },
      "maxItems": 25
    },
    "counts": {
      "$ref": "#/$defs/ListCounts"
    },
    "next": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "snapshot": {
              "$ref": "#/$defs/SyncCursor"
            },
            "settledAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            }
          },
          "required": [
            "snapshot",
            "settledAt",
            "threadId"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "through",
    "threads",
    "counts",
    "next"
  ],
  "additionalProperties": false
}
```

## EarlierSettledRequest

```json
{
  "type": "object",
  "properties": {
    "target": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "environment"
            },
            "environmentId": {
              "$ref": "#/$defs/EnvironmentId"
            }
          },
          "required": [
            "kind",
            "environmentId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "project"
            },
            "projectId": {
              "$ref": "#/$defs/ProjectId"
            }
          },
          "required": [
            "kind",
            "projectId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "after": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "snapshot": {
              "$ref": "#/$defs/SyncCursor"
            },
            "settledAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            }
          },
          "required": [
            "snapshot",
            "settledAt",
            "threadId"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "target",
    "after"
  ],
  "additionalProperties": false
}
```

## Environment

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "version"
  ],
  "additionalProperties": false
}
```

## EnvironmentDescription

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "owner": {
          "const": "desktop"
        },
        "onDesktopQuit": {
          "const": "stop"
        },
        "platform": {
          "const": "macos"
        },
        "onLastWindow": {
          "const": "keepRunning"
        }
      },
      "required": [
        "owner",
        "onDesktopQuit",
        "platform",
        "onLastWindow"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "owner": {
          "const": "desktop"
        },
        "onDesktopQuit": {
          "const": "stop"
        },
        "platform": {
          "enum": [
            "windows",
            "linux"
          ],
          "type": "string"
        },
        "onLastWindow": {
          "const": "stop"
        }
      },
      "required": [
        "owner",
        "onDesktopQuit",
        "platform",
        "onLastWindow"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "owner": {
          "enum": [
            "service",
            "foreground"
          ],
          "type": "string"
        },
        "platform": {
          "enum": [
            "macos",
            "windows",
            "linux"
          ],
          "type": "string"
        },
        "onLastWindow": {
          "const": "keepRunning"
        },
        "onDesktopQuit": {
          "const": "keepRunning"
        }
      },
      "required": [
        "owner",
        "platform",
        "onLastWindow",
        "onDesktopQuit"
      ],
      "additionalProperties": false
    }
  ]
}
```

## EnvironmentGeneration

```json
{
  "type": "string",
  "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
}
```

## EnvironmentId

```json
{
  "type": "string",
  "minLength": 1
}
```

## EnvironmentIdentity

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "publicKey": {
      "$ref": "#/$defs/P256PublicKey"
    },
    "keyVersion": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "publicKey",
    "keyVersion"
  ],
  "additionalProperties": false
}
```

## EnvironmentSessionId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ExecutorCapabilities

```json
{
  "type": "object",
  "properties": {
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "family": {
      "$ref": "#/$defs/AdapterFamily"
    },
    "version": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "checkedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "matrix": {
      "$ref": "#/$defs/CapabilityMatrix"
    },
    "permission": {
      "$ref": "#/$defs/InstancePermission"
    },
    "textGeneration": {
      "$ref": "#/$defs/CapabilitySupport"
    }
  },
  "required": [
    "instanceId",
    "family",
    "version",
    "checkedAt",
    "matrix"
  ],
  "additionalProperties": false
}
```

## ExecutorInstanceId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ExecutorInstanceSnapshot

```json
{
  "type": "object",
  "properties": {
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "family": {
      "$ref": "#/$defs/AdapterFamily"
    },
    "version": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "checkedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "matrix": {
      "$ref": "#/$defs/CapabilityMatrix"
    },
    "permission": {
      "$ref": "#/$defs/InstancePermission"
    },
    "textGeneration": {
      "$ref": "#/$defs/CapabilitySupport"
    }
  },
  "required": [
    "instanceId",
    "family",
    "version",
    "checkedAt",
    "matrix",
    "permission"
  ],
  "additionalProperties": false
}
```

## ExecutorKeyId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ExecutorPrincipal

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "executor"
    },
    "id": {
      "$ref": "#/$defs/PrincipalId"
    },
    "executorInstanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    }
  },
  "required": [
    "kind",
    "id",
    "executorInstanceId",
    "threadId",
    "attemptId"
  ],
  "additionalProperties": false
}
```

## ExecutorSessionObservation

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "executorObservation"
    },
    "id": {
      "$ref": "#/$defs/TimelineItemId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "source": {
      "type": "object",
      "properties": {
        "instanceId": {
          "$ref": "#/$defs/ExecutorInstanceId"
        },
        "nativeSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "eventId": {
          "type": "string",
          "minLength": 1
        },
        "sourceId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "instanceId",
        "nativeSessionId",
        "epoch",
        "eventId",
        "sourceId"
      ],
      "additionalProperties": false
    },
    "category": {
      "enum": [
        "turn",
        "content",
        "toolActivity",
        "request",
        "history",
        "other"
      ],
      "type": "string"
    },
    "observedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "redactedSummary": {
      "type": "string"
    },
    "assignment": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "session"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "attempt"
            },
            "attemptId": {
              "$ref": "#/$defs/AttemptId"
            },
            "relationship": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "root"
                    },
                    "nativeRootTurnId": {
                      "$ref": "#/$defs/NativeRootTurnId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeRootTurnId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "item"
                    },
                    "nativeItemId": {
                      "$ref": "#/$defs/NativeItemId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeItemId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "request"
                    },
                    "nativeRequestId": {
                      "$ref": "#/$defs/NativeRequestId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeRequestId"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "kind",
            "attemptId",
            "relationship"
          ],
          "additionalProperties": false
        }
      ]
    },
    "createdPosition": {
      "$ref": "#/$defs/SyncPosition"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "kind",
    "id",
    "threadId",
    "source",
    "category",
    "observedAt",
    "redactedSummary",
    "assignment",
    "createdPosition",
    "version"
  ],
  "additionalProperties": false
}
```

## ExecutorSessionObservationPayload

```json
{
  "type": "object",
  "properties": {
    "category": {
      "enum": [
        "turn",
        "content",
        "toolActivity",
        "request",
        "history",
        "other"
      ],
      "type": "string"
    },
    "observedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "redactedSummary": {
      "type": "string"
    }
  },
  "required": [
    "category",
    "observedAt",
    "redactedSummary"
  ],
  "additionalProperties": false
}
```

## ExecutorTurnUpdate

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "round.started"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "nativeRootTurnId": {
          "$ref": "#/$defs/NativeRootTurnId"
        },
        "nativeSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "startedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "selectedMode": {
          "$ref": "#/$defs/PermissionMode"
        },
        "effectiveMode": {
          "$ref": "#/$defs/PermissionMode"
        },
        "effectivePolicy": {
          "type": "object",
          "properties": {
            "approvalsReviewer": {
              "const": "user"
            },
            "approvalPolicy": {
              "anyOf": [
                {
                  "enum": [
                    "untrusted",
                    "on-request"
                  ],
                  "type": "string"
                },
                {
                  "type": "object",
                  "properties": {
                    "granular": {
                      "type": "object",
                      "properties": {
                        "rules": {
                          "const": false
                        },
                        "sandbox_approval": {
                          "const": false
                        },
                        "skill_approval": {
                          "const": false
                        },
                        "request_permissions": {
                          "const": false
                        },
                        "mcp_elicitations": {
                          "const": true
                        }
                      },
                      "required": [
                        "rules",
                        "sandbox_approval",
                        "skill_approval",
                        "request_permissions",
                        "mcp_elicitations"
                      ]
                    }
                  },
                  "required": [
                    "granular"
                  ]
                }
              ]
            },
            "sandbox": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "const": "readOnly"
                    },
                    "networkAccess": {
                      "const": false
                    }
                  },
                  "required": [
                    "type",
                    "networkAccess"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "const": "workspaceWrite"
                    },
                    "writableRoots": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "networkAccess": {
                      "const": false
                    },
                    "excludeSlashTmp": {
                      "const": true
                    },
                    "excludeTmpdirEnvVar": {
                      "const": true
                    }
                  },
                  "required": [
                    "type",
                    "writableRoots",
                    "networkAccess",
                    "excludeSlashTmp",
                    "excludeTmpdirEnvVar"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "const": "dangerFullAccess"
                    }
                  },
                  "required": [
                    "type"
                  ]
                }
              ]
            }
          },
          "required": [
            "approvalsReviewer",
            "approvalPolicy",
            "sandbox"
          ]
        },
        "supportedModes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/PermissionMode"
          }
        },
        "enforcement": {
          "const": "native"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "nativeRootTurnId",
        "nativeSessionId",
        "startedAt",
        "selectedMode",
        "effectiveMode",
        "supportedModes",
        "enforcement"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.started"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "command": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "command"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.output"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.ended"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "output": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "exitCode": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "output",
        "exitCode"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "assistant.delta",
            "assistant.final"
          ],
          "type": "string"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "itemId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "itemId",
        "text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "round.ended"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "nativeRootTurnId": {
          "$ref": "#/$defs/NativeRootTurnId"
        },
        "endedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "endTimeEvidence": {
          "$ref": "#/$defs/RoundEndTimeEvidence"
        },
        "outcome": {
          "enum": [
            "completed",
            "stopped",
            "failed",
            "unknown",
            "superseded"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "nativeRootTurnId",
        "endedAt",
        "endTimeEvidence",
        "outcome"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "executor.failed"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "message": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "reason",
        "message"
      ],
      "additionalProperties": false
    }
  ]
}
```

## FileChange

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
    },
    "previousPath": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        {
          "type": "null"
        }
      ]
    },
    "change": {
      "enum": [
        "added",
        "modified",
        "removed",
        "renamed"
      ],
      "type": "string"
    },
    "owner": {
      "$ref": "#/$defs/FileOwnership"
    }
  },
  "required": [
    "path",
    "previousPath",
    "change",
    "owner"
  ],
  "additionalProperties": false
}
```

## FileOwnership

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "observed"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "itemId": {
          "$ref": "#/$defs/NativeItemId"
        }
      },
      "required": [
        "kind",
        "threadId",
        "roundId",
        "attemptId",
        "itemId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unknown"
        },
        "reason": {
          "enum": [
            "noObservation",
            "sharedWriter",
            "overlap"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## FlowWindow

```json
{
  "type": "object",
  "properties": {
    "lane": {
      "const": "window"
    },
    "epoch": {
      "$ref": "#/$defs/ConnectionId"
    },
    "streamId": {
      "type": "integer",
      "minimum": 0,
      "maximum": 2147483647
    },
    "consumedBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limitBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991,
      "description": "Absolute send limit. Advance by consumed bytes. At the limit pause only this stream. Control messages take priority between chunks."
    }
  },
  "required": [
    "lane",
    "epoch",
    "streamId",
    "consumedBytes",
    "limitBytes"
  ],
  "additionalProperties": false
}
```

## ForgeBranch

```json
{
  "type": "object",
  "properties": {
    "repository": {
      "$ref": "#/$defs/ForgeRepository"
    },
    "name": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "repository",
    "name"
  ],
  "additionalProperties": false
}
```

## ForgeFileKey

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 1
    },
    "pull": {
      "$ref": "#/$defs/ForgePull"
    },
    "headOid": {
      "$ref": "#/$defs/GitObjectId"
    },
    "path": {
      "type": "string",
      "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
    }
  },
  "required": [
    "accountId",
    "pull",
    "headOid",
    "path"
  ],
  "additionalProperties": false
}
```

## ForgeFileValue

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "blob"
        },
        "oid": {
          "$ref": "#/$defs/GitObjectId"
        },
        "mode": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "oid",
        "mode"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "deleted"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ForgeHistory

```json
{
  "type": "object",
  "properties": {
    "watch": {
      "$ref": "#/$defs/ForgeWatch"
    },
    "source": {
      "enum": [
        "checks",
        "timeline",
        "discussion"
      ],
      "type": "string"
    },
    "from": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "through": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "events": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ForgeHistoryEvent"
      }
    },
    "coverage": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "complete"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "gap"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "watch",
    "source",
    "from",
    "through",
    "events",
    "coverage"
  ],
  "additionalProperties": false
}
```

## ForgeHistoryEvent

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "kind": {
          "const": "check"
        },
        "head": {
          "$ref": "#/$defs/GitObjectId"
        },
        "result": {
          "enum": [
            "failed",
            "passed",
            "pending",
            "other"
          ],
          "type": "string"
        }
      },
      "required": [
        "id",
        "version",
        "at",
        "kind",
        "head",
        "result"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "kind": {
          "const": "review"
        },
        "state": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "version",
        "at",
        "kind",
        "state"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "kind": {
          "const": "pullRequest"
        },
        "state": {
          "enum": [
            "open",
            "closed",
            "merged"
          ],
          "type": "string"
        }
      },
      "required": [
        "id",
        "version",
        "at",
        "kind",
        "state"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "kind": {
          "const": "comment"
        },
        "author": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "version",
        "at",
        "kind",
        "author"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ForgeMarkView

```json
{
  "type": "object",
  "properties": {
    "principalId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "file": {
      "$ref": "#/$defs/ForgeFileKey"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "result": {
      "$ref": "#/$defs/ForgeReadResult"
    }
  },
  "required": [
    "principalId",
    "file",
    "version",
    "result"
  ],
  "additionalProperties": false
}
```

## ForgeProgress

```json
{
  "type": "object",
  "properties": {
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "request": {
      "$ref": "#/$defs/ForgePublish"
    },
    "steps": {
      "type": "object",
      "properties": {
        "branch": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "waiting"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "issued"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "verify"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "attemptId",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "done"
                },
                "proof": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "const": "branch"
                    },
                    "checkedOutRef": {
                      "type": "string",
                      "minLength": 1
                    },
                    "branch": {
                      "$ref": "#/$defs/ForgeBranch"
                    },
                    "parent": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "worktreeId": {
                      "$ref": "#/$defs/WorktreeId"
                    }
                  },
                  "required": [
                    "step",
                    "checkedOutRef",
                    "branch",
                    "parent",
                    "worktreeId"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "kind",
                "proof"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "skipped"
                },
                "reason": {
                  "const": "omitted"
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        },
        "commit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "waiting"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "issued"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "verify"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "attemptId",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "done"
                },
                "proof": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "const": "commit"
                    },
                    "branch": {
                      "$ref": "#/$defs/ForgeBranch"
                    },
                    "worktreeId": {
                      "$ref": "#/$defs/WorktreeId"
                    },
                    "parent": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "tree": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "inBranchHistory": {
                      "const": true
                    },
                    "oid": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "paths": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                      }
                    },
                    "priorEdits": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "unknown"
                            }
                          },
                          "required": [
                            "kind"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "known"
                            },
                            "paths": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                              }
                            }
                          },
                          "required": [
                            "kind",
                            "paths"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "required": [
                    "step",
                    "branch",
                    "worktreeId",
                    "parent",
                    "tree",
                    "inBranchHistory",
                    "oid",
                    "paths",
                    "priorEdits"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "kind",
                "proof"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "skipped"
                },
                "reason": {
                  "enum": [
                    "omitted",
                    "noChanges"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        },
        "push": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "waiting"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "issued"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "verify"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "attemptId",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "done"
                },
                "proof": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "const": "push"
                    },
                    "branch": {
                      "$ref": "#/$defs/ForgeBranch"
                    },
                    "tip": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "origin": {
                      "enum": [
                        "pushed",
                        "existing",
                        "observed"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "step",
                    "branch",
                    "tip",
                    "origin"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "kind",
                "proof"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "skipped"
                },
                "reason": {
                  "const": "omitted"
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        },
        "pullRequest": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "waiting"
                },
                "blocked": {
                  "type": "object",
                  "properties": {
                    "reason": {
                      "enum": [
                        "incompleteListing",
                        "headChanged",
                        "ambiguous",
                        "inconsistentListing"
                      ],
                      "type": "string"
                    },
                    "numbers": {
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991
                      }
                    }
                  },
                  "required": [
                    "reason",
                    "numbers"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "issued"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "verify"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "attemptId",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "done"
                },
                "proof": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "const": "pullRequest"
                    },
                    "source": {
                      "$ref": "#/$defs/ForgeBranch"
                    },
                    "target": {
                      "$ref": "#/$defs/ForgeBranch"
                    },
                    "number": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "marker": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/CommandId"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "currentHead": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/GitObjectId"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "verifiedMember": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/GitObjectId"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "state": {
                      "enum": [
                        "open",
                        "closed",
                        "merged"
                      ],
                      "type": "string"
                    },
                    "publicationHead": {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    "origin": {
                      "enum": [
                        "created",
                        "existing",
                        "observed"
                      ],
                      "type": "string"
                    },
                    "evidence": {
                      "enum": [
                        "createReply",
                        "knownNumber",
                        "marker",
                        "currentHead",
                        "member"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "step",
                    "source",
                    "target",
                    "number",
                    "marker",
                    "currentHead",
                    "verifiedMember",
                    "state",
                    "publicationHead",
                    "origin",
                    "evidence"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "kind",
                "proof"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "skipped"
                },
                "reason": {
                  "const": "omitted"
                }
              },
              "required": [
                "kind",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "branch",
        "commit",
        "push",
        "pullRequest"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "commandId",
    "request",
    "steps"
  ],
  "additionalProperties": false
}
```

## ForgeProof

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "step": {
          "const": "branch"
        },
        "checkedOutRef": {
          "type": "string",
          "minLength": 1
        },
        "branch": {
          "$ref": "#/$defs/ForgeBranch"
        },
        "parent": {
          "$ref": "#/$defs/GitObjectId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        }
      },
      "required": [
        "step",
        "checkedOutRef",
        "branch",
        "parent",
        "worktreeId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "step": {
          "const": "commit"
        },
        "branch": {
          "$ref": "#/$defs/ForgeBranch"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "parent": {
          "$ref": "#/$defs/GitObjectId"
        },
        "tree": {
          "$ref": "#/$defs/GitObjectId"
        },
        "inBranchHistory": {
          "const": true
        },
        "oid": {
          "$ref": "#/$defs/GitObjectId"
        },
        "paths": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
          }
        },
        "priorEdits": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "known"
                },
                "paths": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                  }
                }
              },
              "required": [
                "kind",
                "paths"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "step",
        "branch",
        "worktreeId",
        "parent",
        "tree",
        "inBranchHistory",
        "oid",
        "paths",
        "priorEdits"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "step": {
          "const": "push"
        },
        "branch": {
          "$ref": "#/$defs/ForgeBranch"
        },
        "tip": {
          "$ref": "#/$defs/GitObjectId"
        },
        "origin": {
          "enum": [
            "pushed",
            "existing",
            "observed"
          ],
          "type": "string"
        }
      },
      "required": [
        "step",
        "branch",
        "tip",
        "origin"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "step": {
          "const": "pullRequest"
        },
        "source": {
          "$ref": "#/$defs/ForgeBranch"
        },
        "target": {
          "$ref": "#/$defs/ForgeBranch"
        },
        "number": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "marker": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommandId"
            },
            {
              "type": "null"
            }
          ]
        },
        "currentHead": {
          "anyOf": [
            {
              "$ref": "#/$defs/GitObjectId"
            },
            {
              "type": "null"
            }
          ]
        },
        "verifiedMember": {
          "anyOf": [
            {
              "$ref": "#/$defs/GitObjectId"
            },
            {
              "type": "null"
            }
          ]
        },
        "state": {
          "enum": [
            "open",
            "closed",
            "merged"
          ],
          "type": "string"
        },
        "publicationHead": {
          "$ref": "#/$defs/GitObjectId"
        },
        "origin": {
          "enum": [
            "created",
            "existing",
            "observed"
          ],
          "type": "string"
        },
        "evidence": {
          "enum": [
            "createReply",
            "knownNumber",
            "marker",
            "currentHead",
            "member"
          ],
          "type": "string"
        }
      },
      "required": [
        "step",
        "source",
        "target",
        "number",
        "marker",
        "currentHead",
        "verifiedMember",
        "state",
        "publicationHead",
        "origin",
        "evidence"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ForgePublish

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "worktreeId": {
      "$ref": "#/$defs/WorktreeId"
    },
    "source": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "target": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "createBranch": {
      "type": "boolean"
    },
    "commit": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "paths": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "string",
                  "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                }
              ],
              "minItems": 1,
              "items": {
                "type": "string",
                "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
              }
            },
            "message": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "paths",
            "message"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "push": {
      "type": "boolean"
    },
    "pullRequest": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "body": {
              "type": "string"
            }
          },
          "required": [
            "title",
            "body"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "threadId",
    "projectId",
    "worktreeId",
    "source",
    "target",
    "createBranch",
    "commit",
    "push",
    "pullRequest"
  ],
  "additionalProperties": false
}
```

## ForgePull

```json
{
  "type": "object",
  "properties": {
    "repository": {
      "$ref": "#/$defs/ForgeRepository"
    },
    "number": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "repository",
    "number"
  ],
  "additionalProperties": false
}
```

## ForgePullMatch

```json
{
  "type": "object",
  "properties": {
    "source": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "target": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "number": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "marker": {
      "anyOf": [
        {
          "$ref": "#/$defs/CommandId"
        },
        {
          "type": "null"
        }
      ]
    },
    "currentHead": {
      "anyOf": [
        {
          "$ref": "#/$defs/GitObjectId"
        },
        {
          "type": "null"
        }
      ]
    },
    "verifiedMember": {
      "anyOf": [
        {
          "$ref": "#/$defs/GitObjectId"
        },
        {
          "type": "null"
        }
      ]
    },
    "state": {
      "enum": [
        "open",
        "closed",
        "merged"
      ],
      "type": "string"
    }
  },
  "required": [
    "source",
    "target",
    "number",
    "marker",
    "currentHead",
    "verifiedMember",
    "state"
  ],
  "additionalProperties": false
}
```

## ForgeReadMark

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unmarked"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "noBaseline"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "marked"
        },
        "value": {
          "$ref": "#/$defs/ForgeFileValue"
        }
      },
      "required": [
        "kind",
        "value"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ForgeReadResult

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "unmarked",
            "noBaseline",
            "noAnswer"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "equal",
            "changed"
          ],
          "type": "string"
        },
        "before": {
          "$ref": "#/$defs/ForgeFileValue"
        },
        "now": {
          "$ref": "#/$defs/ForgeFileValue"
        }
      },
      "required": [
        "kind",
        "before",
        "now"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ForgeRepository

```json
{
  "type": "object",
  "properties": {
    "platform": {
      "const": "github"
    },
    "host": {
      "type": "string",
      "minLength": 1,
      "pattern": "^[a-z0-9.-]+$"
    },
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "platform",
    "host",
    "id"
  ],
  "additionalProperties": false
}
```

## ForgeWatch

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "pull": {
      "$ref": "#/$defs/ForgePull"
    },
    "generation": {
      "$ref": "#/$defs/CommandId"
    }
  },
  "required": [
    "threadId",
    "pull",
    "generation"
  ],
  "additionalProperties": false
}
```

## GitObjectId

```json
{
  "type": "string",
  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
}
```

## GitStatus

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "notRepository"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "granularity": {
          "enum": [
            "branch",
            "detailed"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "target",
        "sequence",
        "granularity"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "invalidated"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "granularity": {
          "enum": [
            "branch",
            "detailed"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "target",
        "sequence",
        "granularity"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "branch"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "head": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "branch"
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                },
                "tip": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "name",
                "tip"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "detached"
                },
                "tip": {
                  "$ref": "#/$defs/GitObjectId"
                }
              },
              "required": [
                "kind",
                "tip"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "target",
        "sequence",
        "head"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "detailed"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "head": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "branch"
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                },
                "tip": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "name",
                "tip"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "detached"
                },
                "tip": {
                  "$ref": "#/$defs/GitObjectId"
                }
              },
              "required": [
                "kind",
                "tip"
              ],
              "additionalProperties": false
            }
          ]
        },
        "staged": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
              },
              "status": {
                "type": "string",
                "minLength": 1
              },
              "insertions": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deletions": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "path",
              "status",
              "insertions",
              "deletions"
            ],
            "additionalProperties": false
          }
        },
        "unstaged": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
              },
              "status": {
                "type": "string",
                "minLength": 1
              },
              "insertions": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deletions": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "path",
              "status",
              "insertions",
              "deletions"
            ],
            "additionalProperties": false
          }
        },
        "untracked": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
          }
        },
        "remote": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unverified"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "verified"
                },
                "upstream": {
                  "type": "string",
                  "minLength": 1
                },
                "ahead": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "behind": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "upstream",
                "ahead",
                "behind"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "target",
        "sequence",
        "head",
        "staged",
        "unstaged",
        "untracked",
        "remote"
      ],
      "additionalProperties": false
    }
  ]
}
```

## GitStatusRequest

```json
{
  "type": "object",
  "properties": {
    "target": {
      "$ref": "#/$defs/WorkspaceTarget"
    },
    "granularity": {
      "enum": [
        "branch",
        "detailed"
      ],
      "type": "string"
    }
  },
  "required": [
    "target",
    "granularity"
  ],
  "additionalProperties": false
}
```

## GitSubscribe

```json
{
  "type": "object",
  "properties": {
    "target": {
      "$ref": "#/$defs/WorkspaceTarget"
    },
    "granularity": {
      "enum": [
        "branch",
        "detailed"
      ],
      "type": "string"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "streamId": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2147483647
    }
  },
  "required": [
    "target",
    "granularity",
    "subscriptionId",
    "streamId"
  ],
  "additionalProperties": false
}
```

## HandoffContext

```json
{
  "type": "object",
  "properties": {
    "transferId": {
      "$ref": "#/$defs/ContextTransferId"
    },
    "source": {
      "$ref": "#/$defs/HandoffSource"
    },
    "messageIds": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MessageId"
      }
    },
    "history": {
      "$ref": "#/$defs/HistoryCoverage"
    }
  },
  "required": [
    "transferId",
    "source",
    "messageIds",
    "history"
  ],
  "additionalProperties": false
}
```

## HandoffSource

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "roundId": {
      "$ref": "#/$defs/RoundId"
    }
  },
  "required": [
    "environmentId",
    "threadId",
    "roundId"
  ],
  "additionalProperties": false
}
```

## HistoryAnchorId

```json
{
  "type": "string",
  "minLength": 1
}
```

## HistoryCoverage

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "coverage": {
          "const": "complete"
        },
        "missingSources": {
          "type": "array",
          "minItems": 0,
          "items": false
        },
        "omittedItems": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "coverage",
        "missingSources",
        "omittedItems"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "coverage": {
          "const": "partial"
        },
        "missingSources": {
          "type": "array",
          "prefixItems": [
            {
              "$ref": "#/$defs/MissingHistorySource"
            }
          ],
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/MissingHistorySource"
          }
        },
        "omittedItems": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "coverage",
        "missingSources",
        "omittedItems"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "coverage": {
          "const": "unknown"
        },
        "omittedItems": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "coverage",
        "omittedItems"
      ],
      "additionalProperties": false
    }
  ]
}
```

## HistoryPage

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "history.page"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "anchor": {
      "$ref": "#/$defs/HistoryAnchorId"
    },
    "verifiedAt": {
      "$ref": "#/$defs/SyncCursor"
    },
    "pageNumber": {
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    },
    "pageCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65536
    },
    "rows": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "$ref": "#/$defs/SynchronizedObject"
          },
          {
            "type": "object",
            "properties": {
              "objectType": {
                "const": "timelineItem"
              },
              "value": {
                "$ref": "#/$defs/TimelineItem"
              }
            },
            "required": [
              "objectType",
              "value"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "olderAnchor": {
      "anyOf": [
        {
          "$ref": "#/$defs/HistoryAnchorId"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "kind",
    "threadId",
    "anchor",
    "verifiedAt",
    "pageNumber",
    "pageCount",
    "rows",
    "olderAnchor"
  ],
  "additionalProperties": false
}
```

## HostInstanceId

```json
{
  "type": "string",
  "minLength": 1
}
```

## HostStatus

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "running"
        },
        "instanceId": {
          "$ref": "#/$defs/HostInstanceId"
        },
        "observedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "instanceId",
        "observedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "stopped"
        },
        "instanceId": {
          "$ref": "#/$defs/HostInstanceId"
        },
        "exitedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "instanceId",
        "exitedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unknown"
        },
        "lastObservedAt": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "lastObservedAt"
      ],
      "additionalProperties": false
    }
  ]
}
```

## InstancePermission

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "ceiling": {
          "const": "ask"
        },
        "selected": {
          "const": "ask"
        }
      },
      "required": [
        "ceiling",
        "selected"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "ceiling": {
          "const": "edits"
        },
        "selected": {
          "enum": [
            "ask",
            "edits"
          ],
          "type": "string"
        }
      },
      "required": [
        "ceiling",
        "selected"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "ceiling": {
          "const": "open"
        },
        "selected": {
          "$ref": "#/$defs/PermissionMode"
        }
      },
      "required": [
        "ceiling",
        "selected"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ListCounts

```json
{
  "type": "object",
  "properties": {
    "active": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "pinned": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "snoozed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "settled": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archived": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "active",
    "pinned",
    "snoozed",
    "settled",
    "archived"
  ],
  "additionalProperties": false
}
```

## Message

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/MessageId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "roundId": {
      "anyOf": [
        {
          "$ref": "#/$defs/RoundId"
        },
        {
          "type": "null"
        }
      ]
    },
    "author": {
      "$ref": "#/$defs/Subject"
    },
    "text": {
      "type": "string"
    },
    "references": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MessageReference"
      }
    },
    "attachments": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/AttachmentReference"
      }
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "threadId",
    "roundId",
    "author",
    "text",
    "references",
    "attachments",
    "version"
  ],
  "additionalProperties": false
}
```

## MessageId

```json
{
  "type": "string",
  "minLength": 1
}
```

## MessageReference

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/ThreadReference"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "mention"
        },
        "path": {
          "type": "string"
        },
        "availability": {
          "enum": [
            "available",
            "unavailable"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "path",
        "availability"
      ],
      "additionalProperties": false
    }
  ]
}
```

## MissingHistorySource

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "missingThread"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "threadId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "missingRound"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "threadId",
        "roundId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "cycle"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "threadId",
        "roundId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## NativeItemId

```json
{
  "type": "string",
  "minLength": 1
}
```

## NativeRequestId

```json
{
  "type": "string",
  "minLength": 1
}
```

## NativeRoot

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/NativeSessionId"
    },
    "id": {
      "$ref": "#/$defs/NativeRootTurnId"
    },
    "beganAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "sessionId",
    "id",
    "beganAt"
  ],
  "additionalProperties": false
}
```

## NativeRootTurnId

```json
{
  "type": "string",
  "minLength": 1
}
```

## NativeSessionId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ObjectChange

```json
{
  "anyOf": [
    {
      "$ref": "#/$defs/TextReturnedEvent"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "context.operation"
        },
        "operation": {
          "$ref": "#/$defs/ContextOperation"
        }
      },
      "required": [
        "kind",
        "operation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "executor.observation"
        },
        "observation": {
          "$ref": "#/$defs/ExecutorSessionObservation"
        }
      },
      "required": [
        "kind",
        "observation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.activity"
        },
        "item": {
          "$ref": "#/$defs/ToolActivityHistoryItem"
        }
      },
      "required": [
        "kind",
        "item"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "child.resultTransfer"
        },
        "transfer": {
          "$ref": "#/$defs/ChildResultTransfer"
        }
      },
      "required": [
        "kind",
        "transfer"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "app.noteRead"
        },
        "observation": {
          "$ref": "#/$defs/AppNoteRead"
        }
      },
      "required": [
        "kind",
        "observation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "thread.summary"
        },
        "summary": {
          "$ref": "#/$defs/ThreadSummary"
        }
      },
      "required": [
        "kind",
        "summary"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "list.counts"
        },
        "counts": {
          "$ref": "#/$defs/ListCounts"
        }
      },
      "required": [
        "kind",
        "counts"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "forge.progress"
        },
        "operation": {
          "$ref": "#/$defs/ForgeProgress"
        }
      },
      "required": [
        "kind",
        "operation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "forge.observation"
        },
        "history": {
          "$ref": "#/$defs/ForgeHistory"
        }
      },
      "required": [
        "kind",
        "history"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "checkpoint.rollbackProgress"
        },
        "progress": {
          "$ref": "#/$defs/RollbackProgress"
        }
      },
      "required": [
        "kind",
        "progress"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "worktree.state"
        },
        "view": {
          "$ref": "#/$defs/WorktreeView"
        }
      },
      "required": [
        "kind",
        "view"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "attention.facts"
        },
        "facts": {
          "$ref": "#/$defs/AttentionFacts"
        }
      },
      "required": [
        "kind",
        "facts"
      ],
      "additionalProperties": false
    },
    {
      "$ref": "#/$defs/ObjectReplacement"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "object.remove"
        },
        "key": {
          "$ref": "#/$defs/ObjectKey"
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "kind",
        "key",
        "version"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "window.enter"
        },
        "key": {
          "$ref": "#/$defs/ObjectKey"
        }
      },
      "required": [
        "kind",
        "key"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "window.leave"
        },
        "key": {
          "$ref": "#/$defs/ObjectKey"
        }
      },
      "required": [
        "kind",
        "key"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "todo.reconcile"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        },
        "result": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "current"
                },
                "request": {
                  "$ref": "#/$defs/TodoRequest"
                }
              },
              "required": [
                "kind",
                "request"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "removed"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "inaccessible"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "todoRequestId",
        "result"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ObjectKey

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "timelineItem"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "id": {
          "$ref": "#/$defs/TimelineItemId"
        }
      },
      "required": [
        "objectType",
        "threadId",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "environment"
        },
        "id": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "project"
        },
        "id": {
          "$ref": "#/$defs/ProjectId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "worktree"
        },
        "id": {
          "$ref": "#/$defs/WorktreeId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "thread"
        },
        "id": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "message"
        },
        "id": {
          "$ref": "#/$defs/MessageId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "round"
        },
        "id": {
          "$ref": "#/$defs/RoundId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "todoRequest"
        },
        "id": {
          "$ref": "#/$defs/TodoRequestId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "checkpointCapture"
        },
        "id": {
          "$ref": "#/$defs/CaptureId"
        }
      },
      "required": [
        "objectType",
        "id"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ObjectReplacement

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "object.replace"
    },
    "object": {
      "$ref": "#/$defs/SynchronizedObject"
    }
  },
  "required": [
    "kind",
    "object"
  ],
  "additionalProperties": false
}
```

## ObjectVersion

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## P256PublicKey

```json
{
  "type": "string",
  "minLength": 87,
  "maxLength": 87,
  "pattern": "^[A-Za-z0-9_-]+$",
  "description": "Uncompressed SEC1 P-256 public point encoded as unpadded base64url."
}
```

## P256Signature

```json
{
  "type": "string",
  "minLength": 86,
  "maxLength": 86,
  "pattern": "^[A-Za-z0-9_-]+$",
  "description": "Fixed-width 64-byte P-256 ECDSA signature encoded as unpadded base64url."
}
```

## PairingChallenge

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "pairing.challenge"
    },
    "requestId": {
      "$ref": "#/$defs/PairingRequestId"
    },
    "claimId": {
      "$ref": "#/$defs/PairingClaimId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    }
  },
  "required": [
    "kind",
    "requestId",
    "claimId",
    "challengeId",
    "challenge"
  ],
  "additionalProperties": false
}
```

## PairingClaimId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PairingExchange

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "pairing.exchange"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "inviteId": {
      "$ref": "#/$defs/PairingInviteId"
    },
    "requestId": {
      "$ref": "#/$defs/PairingRequestId"
    },
    "claimId": {
      "$ref": "#/$defs/PairingClaimId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "deviceKeyId": {
      "$ref": "#/$defs/DeviceKeyId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "publicKey": {
      "$ref": "#/$defs/P256PublicKey"
    },
    "method": {
      "const": "pairing.exchange"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "inviteId",
    "requestId",
    "claimId",
    "deviceId",
    "deviceKeyId",
    "challengeId",
    "challenge",
    "sequence",
    "publicKey",
    "method",
    "signature"
  ],
  "additionalProperties": false
}
```

## PairingInviteId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PairingPending

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "pairing.pending"
    },
    "inviteId": {
      "$ref": "#/$defs/PairingInviteId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "publicKey": {
      "$ref": "#/$defs/P256PublicKey"
    },
    "target": {
      "$ref": "#/$defs/AuthorizationTarget"
    },
    "permissions": {
      "$ref": "#/$defs/PermissionSet"
    },
    "requestId": {
      "$ref": "#/$defs/PairingRequestId"
    },
    "confirmationCode": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "kind",
    "inviteId",
    "environmentId",
    "deviceId",
    "publicKey",
    "target",
    "permissions",
    "requestId",
    "confirmationCode"
  ],
  "additionalProperties": false
}
```

## PairingRequest

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "pairing.request"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "inviteId": {
      "$ref": "#/$defs/PairingInviteId"
    },
    "requestId": {
      "$ref": "#/$defs/PairingRequestId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "publicKey": {
      "$ref": "#/$defs/P256PublicKey"
    },
    "target": {
      "$ref": "#/$defs/AuthorizationTarget"
    },
    "requestedPermissions": {
      "$ref": "#/$defs/PermissionSet",
      "default": [
        "thread.view",
        "thread.send",
        "thread.reply",
        "term.view",
        "term.input",
        "workspace.change",
        "settings.change",
        "access.give",
        "owner.decide"
      ]
    }
  },
  "required": [
    "kind",
    "environmentId",
    "inviteId",
    "requestId",
    "deviceId",
    "publicKey",
    "target"
  ],
  "additionalProperties": false,
  "description": "The default request asks for the nine default permissions. The owner reviews the target and permission list before approval."
}
```

## PairingRequestId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PermissionGrant

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/AccessGrantId"
    },
    "target": {
      "$ref": "#/$defs/AuthorizationTarget"
    },
    "principalId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "permission": {
      "$ref": "#/$defs/PermissionItem"
    },
    "inheritance": {
      "enum": [
        "targetOnly",
        "children"
      ],
      "type": "string"
    },
    "modeCeiling": {
      "$ref": "#/$defs/PermissionMode"
    },
    "grantedBy": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "principalId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "administrator"
            },
            "policyId": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "policyId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "id",
    "target",
    "principalId",
    "permission",
    "inheritance",
    "modeCeiling",
    "grantedBy"
  ],
  "additionalProperties": false
}
```

## PermissionItem

```json
{
  "enum": [
    "thread.view",
    "thread.send",
    "thread.reply",
    "term.view",
    "term.input",
    "workspace.change",
    "settings.change",
    "access.give",
    "owner.decide",
    "environment.upgrade"
  ],
  "type": "string"
}
```

## PermissionMode

```json
{
  "enum": [
    "ask",
    "edits",
    "open"
  ],
  "type": "string"
}
```

## PermissionSet

```json
{
  "type": "array",
  "items": {
    "$ref": "#/$defs/PermissionItem"
  },
  "minItems": 1,
  "maxItems": 10,
  "description": "Device pairing defaults to the nine ordinary permissions. Environment upgrades require an explicit grant."
}
```

## PortAuthorizationTicket

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/PortTicketId"
    },
    "token": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]{43}$"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "service": {
      "$ref": "#/$defs/PortService"
    },
    "issuedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "token",
    "deviceId",
    "connectionId",
    "service",
    "issuedAt",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

## PortMappingId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PortNumber

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 65535
}
```

## PortObservation

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "environmentGeneration": {
      "$ref": "#/$defs/EnvironmentGeneration"
    },
    "port": {
      "$ref": "#/$defs/PortNumber"
    },
    "observedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "const": "listening"
    },
    "ownership": {
      "$ref": "#/$defs/PortOwnership"
    },
    "web": {
      "const": "unverified"
    }
  },
  "required": [
    "environmentId",
    "environmentGeneration",
    "port",
    "observedAt",
    "kind",
    "ownership",
    "web"
  ],
  "additionalProperties": false
}
```

## PortOwnership

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "verified"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "serviceId": {
          "$ref": "#/$defs/PortServiceId"
        },
        "process": {
          "$ref": "#/$defs/ProcessIdentity"
        },
        "registration": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "terminal"
                },
                "terminal": {
                  "$ref": "#/$defs/TerminalAddress"
                }
              },
              "required": [
                "kind",
                "terminal"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "executor"
                },
                "instanceId": {
                  "$ref": "#/$defs/ExecutorInstanceId"
                }
              },
              "required": [
                "kind",
                "instanceId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "developmentProcess"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "projectId",
        "threadId",
        "serviceId",
        "process",
        "registration"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unverified"
        },
        "reason": {
          "enum": [
            "processUnavailable",
            "registrationMissing",
            "processChanged"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## PortService

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "environmentGeneration": {
      "$ref": "#/$defs/EnvironmentGeneration"
    },
    "serviceId": {
      "$ref": "#/$defs/PortServiceId"
    },
    "port": {
      "$ref": "#/$defs/PortNumber"
    },
    "process": {
      "$ref": "#/$defs/ProcessIdentity"
    }
  },
  "required": [
    "environmentId",
    "environmentGeneration",
    "serviceId",
    "port",
    "process"
  ],
  "additionalProperties": false
}
```

## PortServiceId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PortTicketId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PortUrlProbeResult

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "configuredUrl": {
      "type": "string",
      "format": "uri",
      "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
    },
    "checkedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "result": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "responded"
            },
            "status": {
              "type": "integer",
              "minimum": 100,
              "maximum": 599
            }
          },
          "required": [
            "kind",
            "status"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "failed"
            },
            "reason": {
              "enum": [
                "timeout",
                "connectionRefused",
                "tlsRejected",
                "unavailable"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "environmentId",
    "projectId",
    "configuredUrl",
    "checkedAt",
    "result"
  ],
  "additionalProperties": false
}
```

## PreviewAddress

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "environmentGeneration": {
      "$ref": "#/$defs/EnvironmentGeneration"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "host": {
      "$ref": "#/$defs/PreviewHost"
    },
    "hostGeneration": {
      "$ref": "#/$defs/HostInstanceId"
    },
    "tabId": {
      "$ref": "#/$defs/PreviewTabId"
    }
  },
  "required": [
    "environmentId",
    "environmentGeneration",
    "threadId",
    "host",
    "hostGeneration",
    "tabId"
  ],
  "additionalProperties": false
}
```

## PreviewControl

```json
{
  "type": "object",
  "properties": {
    "epoch": {
      "$ref": "#/$defs/PreviewControlEpoch"
    },
    "owner": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "unclaimed"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "instanceId": {
              "$ref": "#/$defs/ExecutorInstanceId"
            },
            "attemptId": {
              "$ref": "#/$defs/AttemptId"
            }
          },
          "required": [
            "kind",
            "instanceId",
            "attemptId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "human"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "connectionId": {
              "$ref": "#/$defs/ConnectionId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "connectionId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "epoch",
    "owner"
  ],
  "additionalProperties": false
}
```

## PreviewControlEpoch

```json
{
  "type": "string",
  "pattern": "^[1-9][0-9]*$"
}
```

## PreviewElementReference

```json
{
  "type": "object",
  "properties": {
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "navigationId": {
      "$ref": "#/$defs/PreviewNavigationId"
    },
    "snapshotId": {
      "$ref": "#/$defs/PreviewSnapshotId"
    },
    "controlEpoch": {
      "$ref": "#/$defs/PreviewControlEpoch"
    },
    "elementId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "address",
    "navigationId",
    "snapshotId",
    "controlEpoch",
    "elementId"
  ],
  "additionalProperties": false
}
```

## PreviewFrame

```json
{
  "type": "object",
  "properties": {
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "frameNumber": {
      "$ref": "#/$defs/PreviewFrameNumber"
    },
    "sampledAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "content": {
      "$ref": "#/$defs/ContentTransferId"
    }
  },
  "required": [
    "address",
    "subscriptionId",
    "frameNumber",
    "sampledAt",
    "content"
  ],
  "additionalProperties": false
}
```

## PreviewFrameAck

```json
{
  "type": "object",
  "properties": {
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "through": {
      "$ref": "#/$defs/PreviewFrameNumber"
    }
  },
  "required": [
    "address",
    "subscriptionId",
    "through"
  ],
  "additionalProperties": false
}
```

## PreviewFrameNumber

```json
{
  "type": "string",
  "pattern": "^[1-9][0-9]*$"
}
```

## PreviewHost

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "environmentBrowser"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "desktopBrowser"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        }
      },
      "required": [
        "kind",
        "deviceId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "deviceBrowser"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        }
      },
      "required": [
        "kind",
        "deviceId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## PreviewNavigate

```json
{
  "type": "object",
  "properties": {
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "controlEpoch": {
      "$ref": "#/$defs/PreviewControlEpoch"
    },
    "navigationId": {
      "$ref": "#/$defs/PreviewNavigationId"
    },
    "requestedUrl": {
      "type": "string",
      "format": "uri",
      "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991,
      "default": 10000
    }
  },
  "required": [
    "commandId",
    "address",
    "controlEpoch",
    "navigationId",
    "requestedUrl"
  ],
  "additionalProperties": false
}
```

## PreviewNavigation

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "idle"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "loading"
        },
        "navigationId": {
          "$ref": "#/$defs/PreviewNavigationId"
        },
        "requestedUrl": {
          "type": "string",
          "format": "uri",
          "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
        },
        "startedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "navigationId",
        "requestedUrl",
        "startedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "success"
        },
        "navigationId": {
          "$ref": "#/$defs/PreviewNavigationId"
        },
        "requestedUrl": {
          "type": "string",
          "format": "uri",
          "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
        },
        "accessUrl": {
          "type": "string",
          "format": "uri",
          "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
        },
        "sampledAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "navigationId",
        "requestedUrl",
        "accessUrl",
        "sampledAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "loadFailed"
        },
        "navigationId": {
          "$ref": "#/$defs/PreviewNavigationId"
        },
        "requestedUrl": {
          "type": "string",
          "format": "uri",
          "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
        },
        "sampledAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "reason": {
          "enum": [
            "timeout",
            "network",
            "tlsRejected",
            "hostUnavailable",
            "unsupported"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "navigationId",
        "requestedUrl",
        "sampledAt",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## PreviewNavigationId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PreviewSnapshotId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PreviewStateVersion

```json
{
  "type": "string",
  "pattern": "^[1-9][0-9]*$"
}
```

## PreviewTabId

```json
{
  "type": "string",
  "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
}
```

## PreviewTabSnapshot

```json
{
  "type": "object",
  "properties": {
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "stateVersion": {
      "$ref": "#/$defs/PreviewStateVersion"
    },
    "title": {
      "type": "string"
    },
    "profile": {
      "$ref": "#/$defs/BrowserProfileIdentity"
    },
    "availability": {
      "enum": [
        "available",
        "hostDisconnected",
        "closed"
      ],
      "type": "string"
    },
    "visibility": {
      "enum": [
        "visible",
        "hidden"
      ],
      "type": "string"
    },
    "navigation": {
      "$ref": "#/$defs/PreviewNavigation"
    },
    "control": {
      "$ref": "#/$defs/PreviewControl"
    }
  },
  "required": [
    "address",
    "stateVersion",
    "title",
    "profile",
    "availability",
    "visibility",
    "navigation",
    "control"
  ],
  "additionalProperties": false
}
```

## PreviewWait

```json
{
  "type": "object",
  "properties": {
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "navigationId": {
      "$ref": "#/$defs/PreviewNavigationId"
    },
    "conditions": {
      "type": "array",
      "prefixItems": [
        {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "element"
                },
                "selector": {
                  "type": "string",
                  "minLength": 1
                },
                "state": {
                  "enum": [
                    "attached",
                    "visible",
                    "hidden",
                    "detached"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "selector",
                "state"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "text"
                },
                "text": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "text"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "url"
                },
                "url": {
                  "type": "string",
                  "format": "uri",
                  "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
                }
              },
              "required": [
                "kind",
                "url"
              ],
              "additionalProperties": false
            }
          ]
        }
      ],
      "minItems": 1,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "element"
              },
              "selector": {
                "type": "string",
                "minLength": 1
              },
              "state": {
                "enum": [
                  "attached",
                  "visible",
                  "hidden",
                  "detached"
                ],
                "type": "string"
              }
            },
            "required": [
              "kind",
              "selector",
              "state"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "text"
              },
              "text": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "kind",
              "text"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "url"
              },
              "url": {
                "type": "string",
                "format": "uri",
                "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/"
              }
            },
            "required": [
              "kind",
              "url"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991,
      "default": 10000
    }
  },
  "required": [
    "commandId",
    "address",
    "navigationId",
    "conditions"
  ],
  "additionalProperties": false
}
```

## PreviewWaitResult

```json
{
  "type": "object",
  "properties": {
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "address": {
      "$ref": "#/$defs/PreviewAddress"
    },
    "navigationId": {
      "$ref": "#/$defs/PreviewNavigationId"
    },
    "sampledAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "outcome": {
      "enum": [
        "satisfied",
        "timedOut",
        "navigationChanged",
        "hostUnavailable"
      ],
      "type": "string"
    }
  },
  "required": [
    "commandId",
    "address",
    "navigationId",
    "sampledAt",
    "outcome"
  ],
  "additionalProperties": false
}
```

## Principal

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/DevicePrincipal"
    },
    {
      "$ref": "#/$defs/ExecutorPrincipal"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "scheduledJob"
        },
        "id": {
          "$ref": "#/$defs/PrincipalId"
        },
        "trigger": {
          "const": "timer"
        }
      },
      "required": [
        "kind",
        "id",
        "trigger"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "helper"
        },
        "id": {
          "$ref": "#/$defs/PrincipalId"
        }
      },
      "required": [
        "kind",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "environmentLink"
        },
        "id": {
          "$ref": "#/$defs/PrincipalId"
        },
        "sourceEnvironmentId": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "kind",
        "id",
        "sourceEnvironmentId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "guest"
        },
        "id": {
          "$ref": "#/$defs/PrincipalId"
        },
        "sharedThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "id",
        "sharedThreadId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## PrincipalId

```json
{
  "type": "string",
  "minLength": 1
}
```

## PrivateSecretRequest

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "type": "object",
      "properties": {
        "kind": {
          "const": "device"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        },
        "keyId": {
          "$ref": "#/$defs/DeviceKeyId"
        }
      },
      "required": [
        "kind",
        "deviceId",
        "keyId"
      ],
      "additionalProperties": false
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "todo.submitSecret"
    },
    "payload": {
      "$ref": "#/$defs/PrivateSecretSubmission"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires owner.decide on the thread and the negotiated privateSecretSubmission feature. Accepted only by the confidential device handler. Never record or echo its payload in public receipts."
}
```

## PrivateSecretSubmission

```json
{
  "type": "object",
  "properties": {
    "target": {
      "$ref": "#/$defs/SecretTarget"
    },
    "choice": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "value"
            },
            "value": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "value"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "reference"
            },
            "namespace": {
              "type": "string",
              "minLength": 1
            },
            "key": {
              "type": "string",
              "minLength": 1
            },
            "version": {
              "$ref": "#/$defs/ObjectVersion"
            }
          },
          "required": [
            "kind",
            "namespace",
            "key",
            "version"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "declined"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "target",
    "choice"
  ],
  "additionalProperties": false
}
```

## ProcessIdentity

```json
{
  "type": "object",
  "properties": {
    "pid": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "startedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991,
      "description": "Operating system process start time in Unix milliseconds."
    }
  },
  "required": [
    "pid",
    "startedAt"
  ],
  "additionalProperties": false
}
```

## Project

```json
{
  "type": "object",
  "properties": {
    "root": {
      "$ref": "#/$defs/ProjectRoot"
    },
    "id": {
      "$ref": "#/$defs/ProjectId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "environmentId",
    "version"
  ],
  "additionalProperties": false
}
```

## ProjectId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ProjectRoot

```json
{
  "type": "object",
  "properties": {
    "directoryId": {
      "type": "string",
      "minLength": 1
    },
    "generation": {
      "$ref": "#/$defs/WorktreeGeneration"
    },
    "realPath": {
      "type": "string",
      "minLength": 1
    },
    "repository": {
      "anyOf": [
        {
          "$ref": "#/$defs/RepositoryIdentity"
        },
        {
          "type": "null"
        }
      ]
    },
    "origin": {
      "anyOf": [
        {
          "$ref": "#/$defs/RepositoryIdentity"
        },
        {
          "type": "null"
        }
      ]
    },
    "relativeToCheckout": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "directoryId",
    "generation",
    "realPath",
    "repository",
    "origin",
    "relativeToCheckout"
  ],
  "additionalProperties": false
}
```

## ProtocolFeatureSet

```json
{
  "type": "array",
  "items": {
    "enum": [
      "strictSchemas",
      "signedRequests",
      "objectReplacementSync",
      "perStreamFlowControl",
      "binaryContentChunks",
      "privateSecretSubmission",
      "queueEditing",
      "timelineItems",
      "directoryDiff"
    ],
    "type": "string"
  },
  "maxItems": 9
}
```

## ProtocolVersion

```json
{
  "type": "object",
  "properties": {
    "major": {
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    },
    "minor": {
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    }
  },
  "required": [
    "major",
    "minor"
  ],
  "additionalProperties": false
}
```

## QueueConflict

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "queueConflict"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "roundId": {
      "anyOf": [
        {
          "$ref": "#/$defs/RoundId"
        },
        {
          "type": "null"
        }
      ]
    },
    "currentVersion": {
      "anyOf": [
        {
          "$ref": "#/$defs/ObjectVersion"
        },
        {
          "type": "null"
        }
      ]
    },
    "reason": {
      "enum": [
        "changed",
        "leftQueue"
      ],
      "type": "string"
    }
  },
  "required": [
    "kind",
    "threadId",
    "roundId",
    "currentVersion",
    "reason"
  ],
  "additionalProperties": false
}
```

## QueueOrder

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "baseVersion": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "roundIds": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/RoundId"
      }
    }
  },
  "required": [
    "threadId",
    "baseVersion",
    "roundIds"
  ],
  "additionalProperties": false
}
```

## QueuePosition

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## QueueUpdate

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "change": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "edited"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            },
            "messageId": {
              "$ref": "#/$defs/MessageId"
            },
            "messageVersion": {
              "$ref": "#/$defs/ObjectVersion"
            }
          },
          "required": [
            "kind",
            "roundId",
            "messageId",
            "messageVersion"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "cancelled"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            }
          },
          "required": [
            "kind",
            "roundId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "reordered"
            },
            "positions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "roundId": {
                    "$ref": "#/$defs/RoundId"
                  },
                  "place": {
                    "$ref": "#/$defs/QueuePosition"
                  }
                },
                "required": [
                  "roundId",
                  "place"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "kind",
            "positions"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "threadId",
    "version",
    "change"
  ],
  "additionalProperties": false
}
```

## QueuedTarget

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "roundId": {
      "$ref": "#/$defs/RoundId"
    },
    "baseVersion": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "threadId",
    "roundId",
    "baseVersion"
  ],
  "additionalProperties": false
}
```

## ReceiptProof

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/NativeSessionId"
    },
    "itemId": {
      "$ref": "#/$defs/NativeItemId"
    }
  },
  "required": [
    "sessionId",
    "itemId"
  ],
  "additionalProperties": false
}
```

## ReleaseVersion

```json
{
  "type": "string",
  "pattern": "^[0-9A-Za-z][0-9A-Za-z._+-]*$"
}
```

## ReminderKey

```json
{
  "type": "object",
  "properties": {
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "databaseGeneration": {
      "type": "string",
      "minLength": 1
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "object": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "request"
            },
            "requestId": {
              "$ref": "#/$defs/TodoRequestId"
            }
          },
          "required": [
            "kind",
            "requestId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "round"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            },
            "attemptId": {
              "$ref": "#/$defs/AttemptId"
            }
          },
          "required": [
            "kind",
            "roundId",
            "attemptId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "ownerId",
    "environmentId",
    "databaseGeneration",
    "threadId",
    "object"
  ],
  "additionalProperties": false
}
```

## ReminderRecord

```json
{
  "type": "object",
  "properties": {
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "key": {
      "$ref": "#/$defs/ReminderKey"
    },
    "state": {
      "enum": [
        "claimed",
        "posted",
        "suppressed",
        "unconfirmed",
        "withdrawn"
      ],
      "type": "string"
    }
  },
  "required": [
    "deviceId",
    "key",
    "state"
  ],
  "additionalProperties": false
}
```

## RemoteSettingTarget

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "environment"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "kind",
        "environmentId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "project"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "projectId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "checkout"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "projectId",
        "worktreeId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ReplayRunRequest

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "replay.run"
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "permission": {
      "$ref": "#/$defs/PermissionMode"
    },
    "input": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "references": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MessageReference"
          }
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/AttachmentReference"
          }
        }
      },
      "required": [
        "text",
        "references",
        "attachments"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "kind",
    "commandId",
    "permission",
    "input"
  ],
  "additionalProperties": false
}
```

## ReplayTurnUpdate

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "round.started"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "nativeSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "nativeRootTurnId": {
          "$ref": "#/$defs/NativeRootTurnId"
        },
        "startedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "phase": {
          "const": "working"
        },
        "selectedMode": {
          "const": "ask"
        },
        "effectiveMode": {
          "const": "ask"
        },
        "supportedModes": {
          "type": "array",
          "prefixItems": [
            {
              "const": "ask"
            }
          ],
          "minItems": 1,
          "items": false
        },
        "enforcement": {
          "const": "adapter"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "nativeSessionId",
        "nativeRootTurnId",
        "startedAt",
        "phase",
        "selectedMode",
        "effectiveMode",
        "supportedModes",
        "enforcement"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.started"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "command": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "command"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.output"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "text": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "tool.ended"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "exitCode": {
          "type": "integer"
        },
        "output": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "callId",
        "exitCode",
        "output"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "assistant.delta"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "itemId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "role": {
          "const": "assistant"
        },
        "streaming": {
          "const": true
        },
        "text": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "itemId",
        "role",
        "streaming",
        "text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "assistant.final"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "itemId": {
          "$ref": "#/$defs/NativeItemId"
        },
        "role": {
          "const": "assistant"
        },
        "streaming": {
          "const": false
        },
        "text": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "itemId",
        "role",
        "streaming",
        "text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "round.ended"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "nativeRootTurnId": {
          "$ref": "#/$defs/NativeRootTurnId"
        },
        "endedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "outcome": {
          "const": "completed"
        },
        "phase": {
          "const": "closing"
        }
      },
      "required": [
        "kind",
        "roundId",
        "attemptId",
        "nativeRootTurnId",
        "endedAt",
        "outcome",
        "phase"
      ],
      "additionalProperties": false
    }
  ]
}
```

## RepositoryIdentity

```json
{
  "type": "object",
  "properties": {
    "host": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?:[a-z0-9.-]+|\\[[a-f0-9:]+\\])$"
    },
    "port": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        },
        {
          "type": "null"
        }
      ]
    },
    "path": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "host",
    "port",
    "path"
  ],
  "additionalProperties": false
}
```

## RollbackPart

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "notRequested"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "pending"
        },
        "execution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "execution"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "running"
        },
        "execution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "execution"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "succeeded"
        },
        "execution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "execution"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "failed"
        },
        "execution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "retryable": {
          "type": "boolean"
        }
      },
      "required": [
        "kind",
        "execution",
        "reason",
        "retryable"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unknown"
        },
        "execution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "execution",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## RollbackProgress

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "externalEffects": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "operationId": {
                "$ref": "#/$defs/CommandId"
              },
              "attemptId": {
                "$ref": "#/$defs/AttemptId"
              },
              "proof": {
                "$ref": "#/$defs/ForgeProof"
              }
            },
            "required": [
              "operationId",
              "attemptId",
              "proof"
            ],
            "additionalProperties": false
          }
        },
        "dialogue": {
          "$ref": "#/$defs/RollbackPart"
        },
        "target": {
          "$ref": "#/$defs/RollbackTarget"
        },
        "files": {
          "$ref": "#/$defs/RollbackPart"
        }
      },
      "required": [
        "commandId",
        "dialogue",
        "target",
        "files"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "externalEffects": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "operationId": {
                "$ref": "#/$defs/CommandId"
              },
              "attemptId": {
                "$ref": "#/$defs/AttemptId"
              },
              "proof": {
                "$ref": "#/$defs/ForgeProof"
              }
            },
            "required": [
              "operationId",
              "attemptId",
              "proof"
            ],
            "additionalProperties": false
          }
        },
        "dialogue": {
          "$ref": "#/$defs/RollbackPart"
        },
        "target": {
          "type": "object",
          "properties": {
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "roundId": {
              "$ref": "#/$defs/RoundId"
            },
            "attemptId": {
              "$ref": "#/$defs/AttemptId"
            },
            "worktreeId": {
              "type": "null"
            },
            "nativeSessionId": {
              "$ref": "#/$defs/NativeSessionId"
            },
            "nativeRootTurnId": {
              "$ref": "#/$defs/NativeRootTurnId"
            },
            "boundary": {
              "enum": [
                "before",
                "after"
              ],
              "type": "string"
            }
          },
          "required": [
            "threadId",
            "roundId",
            "attemptId",
            "worktreeId",
            "nativeSessionId",
            "nativeRootTurnId",
            "boundary"
          ],
          "additionalProperties": false
        },
        "files": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "notRequested"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "commandId",
        "dialogue",
        "target",
        "files"
      ],
      "additionalProperties": false
    }
  ]
}
```

## RollbackTarget

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "worktreeId": {
      "$ref": "#/$defs/WorktreeId"
    },
    "roundId": {
      "$ref": "#/$defs/RoundId"
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "captureId": {
      "$ref": "#/$defs/CaptureId"
    },
    "boundary": {
      "enum": [
        "before",
        "after"
      ],
      "type": "string"
    }
  },
  "required": [
    "threadId",
    "worktreeId",
    "roundId",
    "attemptId",
    "captureId",
    "boundary"
  ],
  "additionalProperties": false
}
```

## Round

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/RoundId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "messageId": {
      "$ref": "#/$defs/MessageId"
    },
    "place": {
      "$ref": "#/$defs/QueuePosition"
    },
    "attempt": {
      "$ref": "#/$defs/RoundAttempt"
    },
    "attempts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "attemptId": {
            "$ref": "#/$defs/AttemptId"
          },
          "deliveryId": {
            "$ref": "#/$defs/DeliveryId"
          },
          "phase": {
            "$ref": "#/$defs/RoundPhase"
          },
          "origin": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "initial"
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "userResend"
                  },
                  "commandId": {
                    "$ref": "#/$defs/CommandId"
                  },
                  "target": {
                    "$ref": "#/$defs/AttemptId"
                  }
                },
                "required": [
                  "kind",
                  "commandId",
                  "target"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "automaticContinuation"
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "required": [
          "attemptId",
          "deliveryId",
          "phase",
          "origin"
        ],
        "additionalProperties": false
      }
    },
    "steering": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "attemptId": {
            "$ref": "#/$defs/AttemptId"
          },
          "messageId": {
            "$ref": "#/$defs/MessageId"
          },
          "state": {
            "enum": [
              "pending",
              "completed"
            ],
            "type": "string"
          },
          "submission": {
            "enum": [
              "submitted",
              "rejected",
              "unknown"
            ],
            "type": "string"
          }
        },
        "required": [
          "attemptId",
          "messageId",
          "state"
        ],
        "additionalProperties": false
      }
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "threadId",
    "messageId",
    "place",
    "attempt",
    "version"
  ],
  "additionalProperties": false
}
```

## RoundAttempt

```json
{
  "type": "object",
  "properties": {
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "deliveryId": {
      "$ref": "#/$defs/DeliveryId"
    },
    "phase": {
      "$ref": "#/$defs/RoundPhase"
    }
  },
  "required": [
    "attemptId",
    "deliveryId",
    "phase"
  ],
  "additionalProperties": false
}
```

## RoundEndTimeEvidence

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "source": {
          "const": "executorReported"
        },
        "executorEndedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "environmentObservedAt": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "source",
        "executorEndedAt",
        "environmentObservedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "source": {
          "const": "environmentObserved"
        },
        "executorEndedAt": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "environmentObservedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "source",
        "executorEndedAt",
        "environmentObservedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "source": {
          "const": "unknown"
        },
        "executorEndedAt": {
          "type": "null"
        },
        "environmentObservedAt": {
          "type": "null"
        }
      },
      "required": [
        "source",
        "executorEndedAt",
        "environmentObservedAt"
      ],
      "additionalProperties": false
    }
  ]
}
```

## RoundId

```json
{
  "type": "string",
  "minLength": 1
}
```

## RoundPhase

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "filed"
        },
        "gate": {
          "enum": [
            "eligible",
            "held"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "gate"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "armed"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "handed"
        },
        "wroteAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "wroteAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "recovering"
        },
        "prior": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "armed"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "handed"
                },
                "wroteAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "kind",
                "wroteAt"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gate": {
          "enum": [
            "eligible",
            "held"
          ],
          "type": "string"
        },
        "action": {
          "enum": [
            "retrySameDelivery",
            "inspectInput"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "prior",
        "gate",
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "uncertain"
        },
        "next": {
          "const": "inspectInput"
        }
      },
      "required": [
        "kind",
        "next"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "received"
        },
        "proof": {
          "$ref": "#/$defs/ReceiptProof"
        }
      },
      "required": [
        "kind",
        "proof"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "working"
        },
        "root": {
          "$ref": "#/$defs/NativeRoot"
        },
        "receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptProof"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "root",
        "receipt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unobserved"
        },
        "seen": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "input"
                },
                "proof": {
                  "$ref": "#/$defs/ReceiptProof"
                }
              },
              "required": [
                "kind",
                "proof"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "root"
                },
                "root": {
                  "$ref": "#/$defs/NativeRoot"
                },
                "receipt": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ReceiptProof"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "root",
                "receipt"
              ],
              "additionalProperties": false
            }
          ]
        },
        "next": {
          "const": "inspectRoot"
        }
      },
      "required": [
        "kind",
        "seen",
        "next"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "closing"
        },
        "root": {
          "$ref": "#/$defs/NativeRoot"
        },
        "receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptProof"
            },
            {
              "type": "null"
            }
          ]
        },
        "endedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "endTimeEvidence": {
          "$ref": "#/$defs/RoundEndTimeEvidence"
        },
        "nativeReason": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "captureId": {
          "$ref": "#/$defs/CaptureId"
        }
      },
      "required": [
        "kind",
        "root",
        "receipt",
        "endedAt",
        "captureId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "finished"
        },
        "root": {
          "$ref": "#/$defs/NativeRoot"
        },
        "receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptProof"
            },
            {
              "type": "null"
            }
          ]
        },
        "endedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "endTimeEvidence": {
          "$ref": "#/$defs/RoundEndTimeEvidence"
        },
        "nativeReason": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "captureId": {
          "$ref": "#/$defs/CaptureId"
        }
      },
      "required": [
        "kind",
        "root",
        "receipt",
        "endedAt",
        "captureId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "endedEarly"
        },
        "root": {
          "$ref": "#/$defs/NativeRoot"
        },
        "receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptProof"
            },
            {
              "type": "null"
            }
          ]
        },
        "endedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "endTimeEvidence": {
          "$ref": "#/$defs/RoundEndTimeEvidence"
        },
        "nativeReason": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "failed",
            "stopped",
            "lost",
            "superseded",
            "unknown"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "root",
        "receipt",
        "endedAt",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "notDelivered"
        },
        "reason": {
          "type": "string"
        },
        "lateReceipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReceiptProof"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "reason",
        "lateReceipt"
      ],
      "additionalProperties": false
    }
  ]
}
```

## Route

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/RouteId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "kind": {
      "$ref": "#/$defs/RouteKind"
    },
    "endpoint": {
      "type": "string",
      "maxLength": 2048,
      "format": "uri",
      "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/(?:[a-zA-Z0-9.-]+|\\[[0-9a-fA-F:.]+\\])(?::0*(?:[1-9]\\d{0,3}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5]))?\\/?$",
      "description": "HTTP origin or HTTPS origin without credentials. Browsers require HTTPS except on loopback, including local SSH forwards."
    },
    "lastObservedSecureContext": {
      "type": "boolean"
    },
    "status": {
      "$ref": "#/$defs/RouteStatus"
    }
  },
  "required": [
    "id",
    "environmentId",
    "kind",
    "endpoint",
    "status"
  ],
  "additionalProperties": false
}
```

## RouteCatalog

```json
{
  "type": "object",
  "properties": {
    "formatVersion": {
      "const": 1
    },
    "environments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "environmentId": {
            "$ref": "#/$defs/EnvironmentId"
          },
          "pinnedIdentity": {
            "anyOf": [
              {
                "$ref": "#/$defs/EnvironmentIdentity"
              },
              {
                "type": "null"
              }
            ]
          },
          "preferredRouteId": {
            "anyOf": [
              {
                "$ref": "#/$defs/RouteId"
              },
              {
                "type": "null"
              }
            ]
          },
          "routes": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "$ref": "#/$defs/RouteId"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "kind": {
                  "$ref": "#/$defs/RouteKind"
                },
                "endpoint": {
                  "type": "string",
                  "maxLength": 2048,
                  "format": "uri",
                  "pattern": "^[hH][tT][tT][pP][sS]?:\\/\\/(?:[a-zA-Z0-9.-]+|\\[[0-9a-fA-F:.]+\\])(?::0*(?:[1-9]\\d{0,3}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5]))?\\/?$",
                  "description": "HTTP origin or HTTPS origin without credentials. Browsers require HTTPS except on loopback, including local SSH forwards."
                },
                "lastObservedSecureContext": {
                  "type": "boolean"
                },
                "status": {
                  "$ref": "#/$defs/RouteStatus"
                },
                "sshProfileReference": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "id",
                "environmentId",
                "kind",
                "endpoint",
                "status"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "environmentId",
          "pinnedIdentity",
          "preferredRouteId",
          "routes"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "formatVersion",
    "environments"
  ],
  "additionalProperties": false
}
```

## RouteDiagnostic

```json
{
  "type": "object",
  "properties": {
    "routeId": {
      "$ref": "#/$defs/RouteId"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "observedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "detail": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "stage": {
              "const": "authentication"
            },
            "reason": {
              "enum": [
                "unknownKey",
                "revokedKey",
                "keyExpired",
                "invalidSignature",
                "challengeExpired",
                "unsupportedProtocolVersion"
              ],
              "type": "string"
            }
          },
          "required": [
            "stage",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "stage": {
              "const": "tlsCertificate"
            },
            "reason": {
              "enum": [
                "untrusted",
                "expired",
                "hostnameMismatch",
                "invalidCertificate"
              ],
              "type": "string"
            }
          },
          "required": [
            "stage",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "stage": {
              "const": "sshHostKey"
            },
            "reason": {
              "enum": [
                "unknownHost",
                "keyChanged",
                "rejected"
              ],
              "type": "string"
            }
          },
          "required": [
            "stage",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "stage": {
              "const": "environmentIdentity"
            },
            "reason": {
              "enum": [
                "invalidSignature",
                "nonceMismatch",
                "pinnedKeyMismatch",
                "keyVersionMismatch"
              ],
              "type": "string"
            }
          },
          "required": [
            "stage",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "stage": {
              "const": "protocolVersion"
            },
            "reason": {
              "const": "unsupportedProtocolVersion"
            },
            "localVersion": {
              "$ref": "#/$defs/ProtocolVersion"
            },
            "remoteVersion": {
              "$ref": "#/$defs/ProtocolVersion"
            }
          },
          "required": [
            "stage",
            "reason",
            "localVersion",
            "remoteVersion"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "routeId",
    "environmentId",
    "observedAt",
    "detail"
  ],
  "additionalProperties": false
}
```

## RouteFailureReason

```json
{
  "anyOf": [
    {
      "enum": [
        "noResponse",
        "connectionRefused",
        "authorizationRejected",
        "insecureContext",
        "revoked"
      ],
      "type": "string"
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "authenticationRejected"
        },
        "reason": {
          "enum": [
            "unknownKey",
            "revokedKey",
            "keyExpired",
            "invalidSignature",
            "challengeExpired",
            "unsupportedProtocolVersion"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "wrongEnvironment"
        },
        "actualEnvironmentId": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "kind",
        "actualEnvironmentId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## RouteId

```json
{
  "type": "string",
  "minLength": 1
}
```

## RouteKind

```json
{
  "enum": [
    "local",
    "lan",
    "ssh",
    "userMesh"
  ],
  "type": "string"
}
```

## RouteStatus

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "untested"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "probing"
        },
        "startedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "startedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "reachable"
        },
        "checkedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "checkedAt"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unavailable"
        },
        "checkedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "reason": {
          "$ref": "#/$defs/RouteFailureReason"
        }
      },
      "required": [
        "kind",
        "checkedAt",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SecretFileGrant

```json
{
  "type": "object",
  "properties": {
    "receiptCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "decisionCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "deliveryId": {
      "$ref": "#/$defs/DeliveryId"
    },
    "target": {
      "type": "object",
      "properties": {
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "instanceId": {
          "$ref": "#/$defs/ExecutorInstanceId"
        },
        "sessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "requestId": {
          "$ref": "#/$defs/NativeRequestId"
        },
        "purpose": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "commandFile"
            },
            "tool": {
              "type": "string",
              "minLength": 1
            },
            "commandId": {
              "$ref": "#/$defs/CommandId"
            }
          },
          "required": [
            "kind",
            "tool",
            "commandId"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "environmentId",
        "projectId",
        "threadId",
        "todoRequestId",
        "version",
        "attemptId",
        "instanceId",
        "sessionId",
        "requestId",
        "purpose"
      ],
      "additionalProperties": false
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "receiptCommandId",
    "decisionCommandId",
    "ownerId",
    "deliveryId",
    "target",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

## SecretReceipt

```json
{
  "type": "object",
  "properties": {
    "receiptCommandId": {
      "$ref": "#/$defs/CommandId"
    },
    "ownerId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "target": {
      "$ref": "#/$defs/SecretTarget"
    },
    "savedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "decision": {
      "enum": [
        "stored",
        "declined"
      ],
      "type": "string"
    }
  },
  "required": [
    "receiptCommandId",
    "ownerId",
    "target",
    "savedAt",
    "expiresAt",
    "decision"
  ],
  "additionalProperties": false
}
```

## SecretTarget

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "todoRequestId": {
      "$ref": "#/$defs/TodoRequestId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "instanceId": {
      "$ref": "#/$defs/ExecutorInstanceId"
    },
    "sessionId": {
      "$ref": "#/$defs/NativeSessionId"
    },
    "requestId": {
      "$ref": "#/$defs/NativeRequestId"
    },
    "purpose": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "toolOnce"
            },
            "tool": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "tool"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "commandFile"
            },
            "tool": {
              "type": "string",
              "minLength": 1
            },
            "commandId": {
              "$ref": "#/$defs/CommandId"
            }
          },
          "required": [
            "kind",
            "tool",
            "commandId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "environmentId",
    "projectId",
    "threadId",
    "todoRequestId",
    "version",
    "attemptId",
    "instanceId",
    "sessionId",
    "requestId",
    "purpose"
  ],
  "additionalProperties": false
}
```

## ServerHello

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "server.hello"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "clientNonce": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "features": {
      "$ref": "#/$defs/ProtocolFeatureSet"
    },
    "identity": {
      "$ref": "#/$defs/EnvironmentIdentity"
    },
    "identityProof": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "connectionId",
    "challengeId",
    "challenge",
    "clientNonce",
    "protocolVersion",
    "features",
    "identity",
    "identityProof"
  ],
  "additionalProperties": false,
  "description": "The client supplies a fresh public nonce in the WebSocket upgrade query (nonce). Verify the signed echo with the pinned environment key before sending a proof. Sign the canonical JSON of all hello fields except identityProof."
}
```

## SessionAuthorized

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "session.authorized"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "environmentSessionId": {
      "$ref": "#/$defs/EnvironmentSessionId"
    },
    "principal": {
      "$ref": "#/$defs/ActivePrincipal"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "authorizedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "features": {
      "$ref": "#/$defs/ProtocolFeatureSet"
    }
  },
  "required": [
    "kind",
    "environmentId",
    "connectionId",
    "environmentSessionId",
    "principal",
    "signer",
    "authorizedAt",
    "protocolVersion",
    "features"
  ],
  "additionalProperties": false
}
```

## SessionConfiguration

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "session.configuration"
    },
    "upgrade": {
      "$ref": "#/$defs/UpgradeView"
    },
    "description": {
      "$ref": "#/$defs/EnvironmentDescription"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "environmentSessionId": {
      "$ref": "#/$defs/EnvironmentSessionId"
    },
    "environment": {
      "$ref": "#/$defs/Environment"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "transportLimits": {
      "$ref": "#/$defs/TransportLimits"
    },
    "executors": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExecutorCapabilities"
      }
    }
  },
  "required": [
    "kind",
    "connectionId",
    "environmentSessionId",
    "environment",
    "version",
    "transportLimits",
    "executors"
  ],
  "additionalProperties": false
}
```

## SessionRejected

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "session.rejected"
    },
    "reason": {
      "enum": [
        "unknownKey",
        "revokedKey",
        "keyExpired",
        "invalidSignature",
        "challengeExpired",
        "unsupportedProtocolVersion"
      ],
      "type": "string"
    }
  },
  "required": [
    "kind",
    "reason"
  ],
  "additionalProperties": false
}
```

## SettingOverlay

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "directoryMode"
        },
        "source": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "organizationDefault"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "policyId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "policyId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "repository"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                },
                "path": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId",
                "path"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "lock"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "policyId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "policyId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "value": {
          "enum": [
            "local",
            "worktree"
          ],
          "type": "string"
        }
      },
      "required": [
        "field",
        "source",
        "version",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "defaultModel"
        },
        "source": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "organizationDefault"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "policyId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "policyId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "lock"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "policyId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "policyId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "value": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "source",
        "version",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeLocation"
        },
        "source": {
          "not": {}
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "value": {
          "$ref": "#/$defs/WorktreeLocation"
        }
      },
      "required": [
        "field",
        "source",
        "version",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeBranchNaming"
        },
        "source": {
          "not": {}
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "value": {
          "$ref": "#/$defs/WorktreeBranchNaming"
        }
      },
      "required": [
        "field",
        "source",
        "version",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeSubmodules"
        },
        "source": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "repository"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                },
                "path": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId",
                "path"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "value": {
          "$ref": "#/$defs/WorktreeSubmodules"
        }
      },
      "required": [
        "field",
        "source",
        "version",
        "value"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SettingRead

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "directoryMode"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout"
      ],
      "additionalProperties": false,
      "description": "Built-in value \"local\". Writable at environment, project, checkout. Repository declarations: true. Administrator lock: true."
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "defaultModel"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout"
      ],
      "additionalProperties": false,
      "description": "Built-in value null. Writable at environment, project, checkout. Repository declarations: false. Administrator lock: true."
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeLocation"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout"
      ],
      "additionalProperties": false,
      "description": "Built-in value {\"kind\":\"default\"}. Writable at environment. Repository declarations: false. Administrator lock: false."
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeBranchNaming"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout"
      ],
      "additionalProperties": false,
      "description": "Built-in value {\"kind\":\"generated\"}. Writable at environment, project, checkout. Repository declarations: false. Administrator lock: false."
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeSubmodules"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout"
      ],
      "additionalProperties": false,
      "description": "Built-in value \"recursive\". Writable at environment, project, checkout. Repository declarations: true. Administrator lock: false."
    }
  ]
}
```

## SettingReadback

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "directoryMode"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "atLayer": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "enum": [
                    "local",
                    "worktree"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        },
        "fieldVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "effective": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "value": {
                  "enum": [
                    "local",
                    "worktree"
                  ],
                  "type": "string"
                },
                "source": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "builtin"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "sourceVersion": {
                  "type": "null"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "value": {
                  "enum": [
                    "local",
                    "worktree"
                  ],
                  "type": "string"
                },
                "source": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "environment"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "project"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "checkout"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "organizationDefault"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "policyId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "policyId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "repository"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        },
                        "path": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId",
                        "path"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "lock"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "policyId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "policyId"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            }
          ]
        },
        "readVersion": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "atLayer",
        "fieldVersion",
        "effective",
        "readVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "defaultModel"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "atLayer": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        },
        "fieldVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "effective": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "value": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "source": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "builtin"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "sourceVersion": {
                  "type": "null"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "value": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "source": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "environment"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "project"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "checkout"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "organizationDefault"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "policyId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "policyId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "lock"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "policyId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "policyId"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            }
          ]
        },
        "readVersion": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "atLayer",
        "fieldVersion",
        "effective",
        "readVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeLocation"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "atLayer": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeLocation"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        },
        "fieldVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "effective": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeLocation"
                },
                "source": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "builtin"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "sourceVersion": {
                  "type": "null"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeLocation"
                },
                "source": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "environment"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            }
          ]
        },
        "readVersion": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "atLayer",
        "fieldVersion",
        "effective",
        "readVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeBranchNaming"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "atLayer": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeBranchNaming"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        },
        "fieldVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "effective": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeBranchNaming"
                },
                "source": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "builtin"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "sourceVersion": {
                  "type": "null"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeBranchNaming"
                },
                "source": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "environment"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "project"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "checkout"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            }
          ]
        },
        "readVersion": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "atLayer",
        "fieldVersion",
        "effective",
        "readVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeSubmodules"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "atLayer": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeSubmodules"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        },
        "fieldVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "effective": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeSubmodules"
                },
                "source": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "builtin"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "sourceVersion": {
                  "type": "null"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "value": {
                  "$ref": "#/$defs/WorktreeSubmodules"
                },
                "source": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "environment"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "project"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "checkout"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "repository"
                        },
                        "environmentId": {
                          "$ref": "#/$defs/EnvironmentId"
                        },
                        "projectId": {
                          "$ref": "#/$defs/ProjectId"
                        },
                        "worktreeId": {
                          "$ref": "#/$defs/WorktreeId"
                        },
                        "path": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "kind",
                        "environmentId",
                        "projectId",
                        "worktreeId",
                        "path"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceVersion": {
                  "$ref": "#/$defs/ObjectVersion"
                }
              },
              "required": [
                "value",
                "source",
                "sourceVersion"
              ],
              "additionalProperties": false
            }
          ]
        },
        "readVersion": {
          "$ref": "#/$defs/ObjectVersion"
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "atLayer",
        "fieldVersion",
        "effective",
        "readVersion"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SettingRow

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "directoryMode"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "enum": [
                    "local",
                    "worktree"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "defaultModel"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeLocation"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeLocation"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeBranchNaming"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeBranchNaming"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeSubmodules"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "version": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "explicit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeSubmodules"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "version",
        "explicit"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SettingSaved

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "settingSaved"
    },
    "supportedFields": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "readback": {
      "$ref": "#/$defs/SettingReadback"
    }
  },
  "required": [
    "kind",
    "supportedFields",
    "readback"
  ],
  "additionalProperties": false
}
```

## SettingSource

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "environment"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        }
      },
      "required": [
        "kind",
        "environmentId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "project"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "projectId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "checkout"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        }
      },
      "required": [
        "kind",
        "environmentId",
        "projectId",
        "worktreeId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "repository"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "path": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "environmentId",
        "projectId",
        "worktreeId",
        "path"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "organizationDefault"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "policyId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "environmentId",
        "policyId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "lock"
        },
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "policyId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "environmentId",
        "policyId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "builtin"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "device"
        },
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        }
      },
      "required": [
        "kind",
        "deviceId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SettingWrite

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "directoryMode"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "enum": [
                    "local",
                    "worktree"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "defaultModel"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeLocation"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeLocation"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeBranchNaming"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeBranchNaming"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "field": {
          "const": "worktreeSubmodules"
        },
        "target": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "environment"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                }
              },
              "required": [
                "kind",
                "environmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "set"
                },
                "value": {
                  "$ref": "#/$defs/WorktreeSubmodules"
                }
              },
              "required": [
                "kind",
                "value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "field",
        "target",
        "checkout",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SettingWriteFailure

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "settingLocked"
        },
        "request": {
          "$ref": "#/$defs/SettingRead"
        },
        "supportedFields": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "lockedBy": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "lock"
            },
            "environmentId": {
              "$ref": "#/$defs/EnvironmentId"
            },
            "policyId": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "environmentId",
            "policyId"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "request",
        "supportedFields",
        "lockedBy"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "settingVersionConflict"
        },
        "supportedFields": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "readback": {
          "$ref": "#/$defs/SettingReadback"
        }
      },
      "required": [
        "kind",
        "supportedFields",
        "readback"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unrecognizedSetting"
        },
        "field": {
          "type": "string"
        },
        "target": {
          "$ref": "#/$defs/RemoteSettingTarget"
        },
        "checkout": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "checkout"
                },
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                },
                "worktreeId": {
                  "$ref": "#/$defs/WorktreeId"
                }
              },
              "required": [
                "kind",
                "environmentId",
                "projectId",
                "worktreeId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "supportedFields": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": [
        "kind",
        "field",
        "target",
        "checkout",
        "supportedFields"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SignedRequest

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/access.listGrants"
    },
    {
      "$ref": "#/$defs/access.listChanges"
    },
    {
      "$ref": "#/$defs/device.pairing.listInvites"
    },
    {
      "$ref": "#/$defs/device.pairing.listApplications"
    },
    {
      "$ref": "#/$defs/device.pairing.cancel"
    },
    {
      "$ref": "#/$defs/thread.readEarlierSettled"
    },
    {
      "$ref": "#/$defs/thread.changeLifecycle"
    },
    {
      "$ref": "#/$defs/thread.compact"
    },
    {
      "$ref": "#/$defs/thread.clear"
    },
    {
      "$ref": "#/$defs/input.editQueued"
    },
    {
      "$ref": "#/$defs/input.cancelQueued"
    },
    {
      "$ref": "#/$defs/input.reorderQueue"
    },
    {
      "$ref": "#/$defs/checkpoint.readRollbackPart"
    },
    {
      "$ref": "#/$defs/checkpoint.retryDialogue"
    },
    {
      "$ref": "#/$defs/checkpoint.retryFiles"
    },
    {
      "$ref": "#/$defs/git.readStatus"
    },
    {
      "$ref": "#/$defs/git.subscribeStatus"
    },
    {
      "$ref": "#/$defs/workspace.list"
    },
    {
      "$ref": "#/$defs/workspace.readFile"
    },
    {
      "$ref": "#/$defs/workspace.writeFile"
    },
    {
      "$ref": "#/$defs/workspace.search"
    },
    {
      "$ref": "#/$defs/host.listDirectory"
    },
    {
      "$ref": "#/$defs/workspace.openEditor"
    },
    {
      "$ref": "#/$defs/todo.readSecretReceipt"
    },
    {
      "$ref": "#/$defs/thread.inspectCheckout"
    },
    {
      "$ref": "#/$defs/thread.launchChildren"
    },
    {
      "$ref": "#/$defs/thread.readChild"
    },
    {
      "$ref": "#/$defs/thread.cancelChild"
    },
    {
      "$ref": "#/$defs/app.callback"
    },
    {
      "$ref": "#/$defs/app.confirm"
    },
    {
      "$ref": "#/$defs/app.updateNote"
    },
    {
      "$ref": "#/$defs/environment.upgrade"
    },
    {
      "$ref": "#/$defs/forge.publish"
    },
    {
      "$ref": "#/$defs/forge.operation"
    },
    {
      "$ref": "#/$defs/forge.fileReading"
    },
    {
      "$ref": "#/$defs/forge.markFile"
    },
    {
      "$ref": "#/$defs/forge.history"
    },
    {
      "$ref": "#/$defs/checkpoint.diff"
    },
    {
      "$ref": "#/$defs/checkpoint.rollbackDialogue"
    },
    {
      "$ref": "#/$defs/checkpoint.restoreFiles"
    },
    {
      "$ref": "#/$defs/checkpoint.rollback"
    },
    {
      "$ref": "#/$defs/terminal.open"
    },
    {
      "$ref": "#/$defs/terminal.attach"
    },
    {
      "$ref": "#/$defs/terminal.control"
    },
    {
      "$ref": "#/$defs/terminal.write"
    },
    {
      "$ref": "#/$defs/terminal.resize"
    },
    {
      "$ref": "#/$defs/terminal.ack"
    },
    {
      "$ref": "#/$defs/terminal.detach"
    },
    {
      "$ref": "#/$defs/terminal.close"
    },
    {
      "$ref": "#/$defs/worktree.prepare"
    },
    {
      "$ref": "#/$defs/worktree.retrySetup"
    },
    {
      "$ref": "#/$defs/worktree.clean"
    },
    {
      "$ref": "#/$defs/settings.read"
    },
    {
      "$ref": "#/$defs/settings.write"
    },
    {
      "$ref": "#/$defs/attention.read"
    },
    {
      "$ref": "#/$defs/executor.configure"
    },
    {
      "$ref": "#/$defs/executor.refresh"
    },
    {
      "$ref": "#/$defs/project.register"
    },
    {
      "$ref": "#/$defs/thread.rename"
    },
    {
      "$ref": "#/$defs/thread.start"
    },
    {
      "$ref": "#/$defs/input.send"
    },
    {
      "$ref": "#/$defs/input.steer"
    },
    {
      "$ref": "#/$defs/input.releaseQueue"
    },
    {
      "$ref": "#/$defs/round.readStop"
    },
    {
      "$ref": "#/$defs/round.stop"
    },
    {
      "$ref": "#/$defs/input.resendUnknown"
    },
    {
      "$ref": "#/$defs/input.dropUnknown"
    },
    {
      "$ref": "#/$defs/todo.readAnswer"
    },
    {
      "$ref": "#/$defs/todo.answer"
    },
    {
      "$ref": "#/$defs/todo.decide"
    },
    {
      "$ref": "#/$defs/access.grant"
    },
    {
      "$ref": "#/$defs/access.revoke"
    },
    {
      "$ref": "#/$defs/access.listSessions"
    },
    {
      "$ref": "#/$defs/device.pairing.invite"
    },
    {
      "$ref": "#/$defs/device.pairing.approve"
    },
    {
      "$ref": "#/$defs/device.revoke"
    },
    {
      "$ref": "#/$defs/subscription.openThread"
    },
    {
      "$ref": "#/$defs/subscription.openList"
    },
    {
      "$ref": "#/$defs/thread.readHistory"
    },
    {
      "$ref": "#/$defs/tool.readActivity"
    },
    {
      "$ref": "#/$defs/history.pageSaved"
    },
    {
      "$ref": "#/$defs/subscription.close"
    },
    {
      "$ref": "#/$defs/subscription.pageSaved"
    },
    {
      "$ref": "#/$defs/subscription.installed"
    },
    {
      "$ref": "#/$defs/subscription.gap"
    },
    {
      "$ref": "#/$defs/attachment.upload"
    },
    {
      "$ref": "#/$defs/attachment.download"
    }
  ]
}
```

## Subject

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "person"
        },
        "id": {
          "$ref": "#/$defs/PrincipalId"
        }
      },
      "required": [
        "kind",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "executor"
        },
        "id": {
          "$ref": "#/$defs/ExecutorInstanceId"
        }
      },
      "required": [
        "kind",
        "id"
      ],
      "additionalProperties": false
    }
  ]
}
```

## SubscriptionId

```json
{
  "type": "string",
  "minLength": 1
}
```

## SubscriptionPage

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "subscription.page"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "passId": {
      "$ref": "#/$defs/SyncPassId"
    },
    "through": {
      "$ref": "#/$defs/SyncCursor"
    },
    "pageNumber": {
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    },
    "pageCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65536
    },
    "changes": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ObjectChange"
      }
    }
  },
  "required": [
    "kind",
    "subscriptionId",
    "passId",
    "through",
    "pageNumber",
    "pageCount",
    "changes"
  ],
  "additionalProperties": false
}
```

## SyncCursor

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "databaseGeneration": {
      "type": "string",
      "minLength": 1
    },
    "visibilityGeneration": {
      "type": "string",
      "minLength": 1
    },
    "scope": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "list"
            },
            "projectId": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ProjectId"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "kind",
            "projectId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "thread"
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            }
          },
          "required": [
            "kind",
            "threadId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "shapeVersion": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "through": {
      "$ref": "#/$defs/SyncPosition"
    }
  },
  "required": [
    "environmentId",
    "databaseGeneration",
    "visibilityGeneration",
    "scope",
    "shapeVersion",
    "through"
  ],
  "additionalProperties": false
}
```

## SyncPassId

```json
{
  "type": "string",
  "minLength": 1
}
```

## SyncPosition

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## SynchronizedObject

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "environment"
        },
        "value": {
          "$ref": "#/$defs/Environment"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "project"
        },
        "value": {
          "$ref": "#/$defs/Project"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "worktree"
        },
        "value": {
          "$ref": "#/$defs/Worktree"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "thread"
        },
        "value": {
          "$ref": "#/$defs/Thread"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "message"
        },
        "value": {
          "$ref": "#/$defs/Message"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "round"
        },
        "value": {
          "$ref": "#/$defs/Round"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "todoRequest"
        },
        "value": {
          "$ref": "#/$defs/TodoRequest"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "objectType": {
          "const": "checkpointCapture"
        },
        "value": {
          "$ref": "#/$defs/CheckpointCapture"
        }
      },
      "required": [
        "objectType",
        "value"
      ],
      "additionalProperties": false
    }
  ]
}
```

## TerminalAddress

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    }
  },
  "required": [
    "threadId",
    "terminalId",
    "generation"
  ],
  "additionalProperties": false
}
```

## TerminalControl

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "environmentSessionId": {
      "$ref": "#/$defs/EnvironmentSessionId"
    },
    "lease": {
      "$ref": "#/$defs/CommandId"
    }
  },
  "required": [
    "threadId",
    "terminalId",
    "generation",
    "subscriptionId",
    "environmentSessionId",
    "lease"
  ],
  "additionalProperties": false
}
```

## TerminalGap

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "terminal.gap"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "from": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "to": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "missingBytes": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "head": {
      "$ref": "#/$defs/TerminalOffset"
    }
  },
  "required": [
    "kind",
    "threadId",
    "terminalId",
    "generation",
    "subscriptionId",
    "from",
    "to",
    "missingBytes",
    "head"
  ],
  "additionalProperties": false
}
```

## TerminalGeneration

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## TerminalGrid

```json
{
  "type": "object",
  "properties": {
    "cols": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4096
    },
    "rows": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4096
    }
  },
  "required": [
    "cols",
    "rows"
  ],
  "additionalProperties": false
}
```

## TerminalId

```json
{
  "type": "string",
  "minLength": 1
}
```

## TerminalInputReceipt

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "outcome": {
      "enum": [
        "accepted",
        "confirmed",
        "unknown"
      ],
      "type": "string"
    }
  },
  "required": [
    "threadId",
    "terminalId",
    "generation",
    "commandId",
    "outcome"
  ],
  "additionalProperties": false
}
```

## TerminalOffset

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## TerminalOutput

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "terminal.output"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "from": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "to": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "content": {
      "$ref": "#/$defs/ContentTransferId"
    }
  },
  "required": [
    "kind",
    "threadId",
    "terminalId",
    "generation",
    "subscriptionId",
    "from",
    "to",
    "content"
  ],
  "additionalProperties": false
}
```

## TerminalSession

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "previous": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "generation": {
                  "$ref": "#/$defs/TerminalGeneration"
                },
                "head": {
                  "$ref": "#/$defs/TerminalOffset"
                },
                "process": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ProcessIdentity"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reason": {
                  "const": "environmentRestart"
                }
              },
              "required": [
                "generation",
                "head",
                "process",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "head": {
          "$ref": "#/$defs/TerminalOffset"
        },
        "kind": {
          "const": "starting"
        },
        "grid": {
          "$ref": "#/$defs/TerminalGrid"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "previous",
        "head",
        "kind",
        "grid"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "previous": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "generation": {
                  "$ref": "#/$defs/TerminalGeneration"
                },
                "head": {
                  "$ref": "#/$defs/TerminalOffset"
                },
                "process": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ProcessIdentity"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reason": {
                  "const": "environmentRestart"
                }
              },
              "required": [
                "generation",
                "head",
                "process",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "head": {
          "$ref": "#/$defs/TerminalOffset"
        },
        "kind": {
          "const": "running"
        },
        "process": {
          "$ref": "#/$defs/ProcessIdentity"
        },
        "grid": {
          "$ref": "#/$defs/TerminalGrid"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "previous",
        "head",
        "kind",
        "process",
        "grid"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "previous": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "generation": {
                  "$ref": "#/$defs/TerminalGeneration"
                },
                "head": {
                  "$ref": "#/$defs/TerminalOffset"
                },
                "process": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ProcessIdentity"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reason": {
                  "const": "environmentRestart"
                }
              },
              "required": [
                "generation",
                "head",
                "process",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "head": {
          "$ref": "#/$defs/TerminalOffset"
        },
        "kind": {
          "const": "exited"
        },
        "process": {
          "anyOf": [
            {
              "$ref": "#/$defs/ProcessIdentity"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "shellExit",
            "closed",
            "environmentStopped"
          ],
          "type": "string"
        },
        "code": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "signal": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "previous",
        "head",
        "kind",
        "process",
        "reason",
        "code",
        "signal"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "previous": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "generation": {
                  "$ref": "#/$defs/TerminalGeneration"
                },
                "head": {
                  "$ref": "#/$defs/TerminalOffset"
                },
                "process": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/ProcessIdentity"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reason": {
                  "const": "environmentRestart"
                }
              },
              "required": [
                "generation",
                "head",
                "process",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "head": {
          "$ref": "#/$defs/TerminalOffset"
        },
        "kind": {
          "const": "lost"
        },
        "process": {
          "anyOf": [
            {
              "$ref": "#/$defs/ProcessIdentity"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "const": "environmentRestart"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "previous",
        "head",
        "kind",
        "process",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## TerminalSnapshot

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "terminal.snapshot"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "terminalId": {
      "$ref": "#/$defs/TerminalId"
    },
    "generation": {
      "$ref": "#/$defs/TerminalGeneration"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "retainedFrom": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "from": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "head": {
      "$ref": "#/$defs/TerminalOffset"
    },
    "content": {
      "anyOf": [
        {
          "$ref": "#/$defs/ContentTransferId"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "kind",
    "threadId",
    "terminalId",
    "generation",
    "subscriptionId",
    "retainedFrom",
    "from",
    "head",
    "content"
  ],
  "additionalProperties": false
}
```

## TextReturnResult

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "textReturned"
    },
    "transferId": {
      "$ref": "#/$defs/ContextTransferId"
    },
    "source": {
      "$ref": "#/$defs/HandoffSource"
    },
    "target": {
      "type": "object",
      "properties": {
        "environmentId": {
          "$ref": "#/$defs/EnvironmentId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "environmentId",
        "threadId"
      ],
      "additionalProperties": false
    },
    "text": {
      "type": "string"
    },
    "history": {
      "$ref": "#/$defs/HistoryCoverage"
    },
    "input": {
      "type": "object",
      "properties": {
        "messageId": {
          "$ref": "#/$defs/MessageId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "deliveryId": {
          "$ref": "#/$defs/DeliveryId"
        }
      },
      "required": [
        "messageId",
        "roundId",
        "attemptId",
        "deliveryId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "kind",
    "transferId",
    "source",
    "target",
    "text",
    "history",
    "input"
  ],
  "additionalProperties": false
}
```

## TextReturnedEvent

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "handoff.textReturned"
    },
    "result": {
      "$ref": "#/$defs/TextReturnResult"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "kind",
    "result",
    "version"
  ],
  "additionalProperties": false
}
```

## Thread

```json
{
  "type": "object",
  "properties": {
    "lifecycle": {
      "$ref": "#/$defs/ThreadLifecycle"
    },
    "directory": {
      "$ref": "#/$defs/DirectoryBinding"
    },
    "id": {
      "$ref": "#/$defs/ThreadId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "worktreeId": {
      "anyOf": [
        {
          "$ref": "#/$defs/WorktreeId"
        },
        {
          "type": "null"
        }
      ]
    },
    "title": {
      "type": "string"
    },
    "lineage": {
      "$ref": "#/$defs/ThreadLineage"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "projectId",
    "worktreeId",
    "title",
    "lineage",
    "version"
  ],
  "additionalProperties": false
}
```

## ThreadChange

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "pin"
        },
        "position": {
          "anyOf": [
            {
              "$ref": "#/$defs/QueuePosition"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "position"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "archive",
            "unarchive",
            "settle",
            "reopen",
            "unpin",
            "wake"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "snooze"
        },
        "until": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "until"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "order"
        },
        "position": {
          "anyOf": [
            {
              "$ref": "#/$defs/QueuePosition"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "position"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ThreadId

```json
{
  "type": "string",
  "minLength": 1
}
```

## ThreadLifecycle

```json
{
  "type": "object",
  "properties": {
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "state": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "active"
            },
            "pinnedAt": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "pinPosition": {
              "anyOf": [
                {
                  "$ref": "#/$defs/QueuePosition"
                },
                {
                  "type": "null"
                }
              ]
            },
            "manualPosition": {
              "anyOf": [
                {
                  "$ref": "#/$defs/QueuePosition"
                },
                {
                  "type": "null"
                }
              ]
            },
            "snoozedUntil": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "kind",
            "pinnedAt",
            "pinPosition",
            "manualPosition",
            "snoozedUntil"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "settled"
            },
            "at": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "reason": {
              "enum": [
                "manual",
                "idle",
                "merged",
                "closed"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind",
            "at",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "archivedAt",
    "state"
  ],
  "additionalProperties": false
}
```

## ThreadLineage

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "root"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "child"
        },
        "parentThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "parentThreadId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "fork"
        },
        "parentThreadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "sourceRoundId": {
          "$ref": "#/$defs/RoundId"
        },
        "sideChat": {
          "type": "boolean"
        }
      },
      "required": [
        "kind",
        "parentThreadId",
        "sourceRoundId",
        "sideChat"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ThreadPullKey

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "pull": {
      "$ref": "#/$defs/ForgePull"
    }
  },
  "required": [
    "threadId",
    "pull"
  ],
  "additionalProperties": false
}
```

## ThreadPullLink

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "pull": {
      "$ref": "#/$defs/ForgePull"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "source": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "target": {
      "$ref": "#/$defs/ForgeBranch"
    },
    "title": {
      "type": "string"
    },
    "repositoryName": {
      "type": "string",
      "minLength": 1
    },
    "lastState": {
      "enum": [
        "open",
        "closed",
        "merged",
        "unknown"
      ],
      "type": "string"
    },
    "checkedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "linkedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "origin": {
      "enum": [
        "created",
        "existing",
        "recovered",
        "explicit"
      ],
      "type": "string"
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "stackPosition": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "threadId",
    "pull",
    "projectId",
    "url",
    "source",
    "target",
    "title",
    "repositoryName",
    "lastState",
    "checkedAt",
    "linkedAt",
    "origin",
    "commandId",
    "stackPosition"
  ],
  "additionalProperties": false
}
```

## ThreadReference

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "thread"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    }
  },
  "required": [
    "kind",
    "threadId"
  ],
  "additionalProperties": false
}
```

## ThreadSummary

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "parentThreadId": {
      "anyOf": [
        {
          "$ref": "#/$defs/ThreadId"
        },
        {
          "type": "null"
        }
      ]
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "title": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lifecycle": {
      "$ref": "#/$defs/ThreadLifecycle"
    },
    "openTodos": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "activeRounds": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "threadId",
    "projectId",
    "parentThreadId",
    "version",
    "title",
    "createdAt",
    "lastActivityAt",
    "lifecycle",
    "openTodos",
    "activeRounds"
  ],
  "additionalProperties": false
}
```

## TimelineItem

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/ExecutorSessionObservation"
    },
    {
      "$ref": "#/$defs/ToolActivityHistoryItem"
    }
  ]
}
```

## TimelineItemId

```json
{
  "type": "string",
  "minLength": 1
}
```

## TodoAnswer

```json
{
  "type": "object",
  "properties": {
    "authorId": {
      "$ref": "#/$defs/PrincipalId"
    },
    "deviceId": {
      "$ref": "#/$defs/DeviceId"
    },
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "attemptId": {
      "$ref": "#/$defs/AttemptId"
    },
    "deliveryId": {
      "$ref": "#/$defs/DeliveryId"
    },
    "content": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "message"
            },
            "messageId": {
              "$ref": "#/$defs/MessageId"
            }
          },
          "required": [
            "kind",
            "messageId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "secretReceipt"
            },
            "commandId": {
              "$ref": "#/$defs/CommandId"
            }
          },
          "required": [
            "kind",
            "commandId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "authorId",
    "at",
    "attemptId",
    "deliveryId",
    "content"
  ],
  "additionalProperties": false
}
```

## TodoRequest

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/TodoRequestId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "roundId": {
      "$ref": "#/$defs/RoundId"
    },
    "body": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "approval"
            },
            "tool": {
              "enum": [
                "command",
                "file",
                "other"
              ],
              "type": "string"
            },
            "choices": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string"
                  },
                  "scope": {
                    "enum": [
                      "once",
                      "session",
                      "project",
                      "persistent",
                      "unknown"
                    ],
                    "type": "string"
                  },
                  "allowsEdit": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "key",
                  "scope",
                  "allowsEdit"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "kind",
            "tool",
            "choices"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "question"
            },
            "questions": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "object",
                  "properties": {
                    "key": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1
                    },
                    "choices": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "key",
                    "text",
                    "choices"
                  ],
                  "additionalProperties": false
                }
              ],
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string"
                  },
                  "text": {
                    "type": "string",
                    "minLength": 1
                  },
                  "choices": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                },
                "required": [
                  "key",
                  "text",
                  "choices"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "kind",
            "questions"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "secret"
            },
            "slot": {
              "type": "string"
            },
            "purpose": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "toolOnce"
                    },
                    "tool": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "tool"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "commandFile"
                    },
                    "tool": {
                      "type": "string",
                      "minLength": 1
                    },
                    "commandId": {
                      "$ref": "#/$defs/CommandId"
                    }
                  },
                  "required": [
                    "kind",
                    "tool",
                    "commandId"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "kind",
            "slot"
          ],
          "additionalProperties": false
        }
      ]
    },
    "state": {
      "$ref": "#/$defs/TodoState"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "threadId",
    "roundId",
    "body",
    "state",
    "version"
  ],
  "additionalProperties": false
}
```

## TodoRequestId

```json
{
  "type": "string",
  "minLength": 1
}
```

## TodoRoute

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "live"
        },
        "subject": {
          "enum": [
            "approval",
            "secret"
          ],
          "type": "string"
        },
        "sessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "requestId": {
          "$ref": "#/$defs/NativeRequestId"
        },
        "fallback": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "expire"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "subject",
        "sessionId",
        "requestId",
        "fallback"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "live"
        },
        "subject": {
          "const": "question"
        },
        "sessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "requestId": {
          "$ref": "#/$defs/NativeRequestId"
        },
        "fallback": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "expire"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "asMessage"
                },
                "questions": {
                  "type": "array",
                  "prefixItems": [
                    {
                      "$ref": "#/$defs/MessageId"
                    }
                  ],
                  "minItems": 1,
                  "items": {
                    "$ref": "#/$defs/MessageId"
                  }
                },
                "nodeId": {
                  "$ref": "#/$defs/WorkNodeId"
                }
              },
              "required": [
                "kind",
                "questions",
                "nodeId"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "subject",
        "sessionId",
        "requestId",
        "fallback"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "message"
        },
        "subject": {
          "const": "question"
        },
        "questions": {
          "type": "array",
          "prefixItems": [
            {
              "$ref": "#/$defs/MessageId"
            }
          ],
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/MessageId"
          }
        },
        "nodeId": {
          "$ref": "#/$defs/WorkNodeId"
        }
      },
      "required": [
        "kind",
        "subject",
        "questions",
        "nodeId"
      ],
      "additionalProperties": false
    }
  ]
}
```

## TodoState

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "open"
        },
        "route": {
          "$ref": "#/$defs/TodoRoute"
        }
      },
      "required": [
        "kind",
        "route"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "answered"
        },
        "route": {
          "$ref": "#/$defs/TodoRoute"
        },
        "answer": {
          "$ref": "#/$defs/TodoAnswer"
        },
        "arrival": {
          "$ref": "#/$defs/AnswerArrival"
        },
        "previousAttempts": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/AnswerAttempt"
          }
        }
      },
      "required": [
        "kind",
        "route",
        "answer",
        "arrival",
        "previousAttempts"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "expired"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ToolActivityBody

```json
{
  "type": "object",
  "properties": {
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "unobserved"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "captured"
            },
            "json": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "json"
          ],
          "additionalProperties": false
        }
      ]
    },
    "output": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "unobserved"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "partial"
            },
            "text": {
              "type": "string"
            },
            "truncated": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "text",
            "truncated"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "complete"
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "text"
          ],
          "additionalProperties": false
        }
      ]
    },
    "status": {
      "enum": [
        "running",
        "completed",
        "failed",
        "unknown"
      ],
      "type": "string"
    },
    "exitCode": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "success": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        }
      ]
    },
    "fileCoverage": {
      "const": "unknown"
    },
    "changes": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ToolActivityFileChange"
      }
    }
  },
  "required": [
    "input",
    "output",
    "status",
    "exitCode",
    "success",
    "fileCoverage",
    "changes"
  ],
  "additionalProperties": false
}
```

## ToolActivityContent

```json
{
  "type": "object",
  "properties": {
    "item": {
      "$ref": "#/$defs/ToolActivityHistoryItem"
    },
    "body": {
      "$ref": "#/$defs/ToolActivityBody"
    }
  },
  "required": [
    "item",
    "body"
  ],
  "additionalProperties": false
}
```

## ToolActivityDetailFrame

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "tool.activity.detail"
    },
    "subscriptionId": {
      "$ref": "#/$defs/SubscriptionId"
    },
    "reference": {
      "$ref": "#/$defs/ToolActivityReference"
    },
    "transferId": {
      "$ref": "#/$defs/ContentTransferId"
    }
  },
  "required": [
    "kind",
    "subscriptionId",
    "reference",
    "transferId"
  ],
  "additionalProperties": false
}
```

## ToolActivityFileChange

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1
    },
    "change": {
      "enum": [
        "created",
        "modified",
        "deleted",
        "moved"
      ],
      "type": "string"
    },
    "destination": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "patch": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "path",
    "change",
    "destination",
    "patch"
  ],
  "additionalProperties": false
}
```

## ToolActivityHistoryItem

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "toolActivity"
    },
    "id": {
      "$ref": "#/$defs/TimelineItemId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "source": {
      "type": "object",
      "properties": {
        "instanceId": {
          "$ref": "#/$defs/ExecutorInstanceId"
        },
        "nativeSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "eventId": {
          "type": "string",
          "minLength": 1
        },
        "sourceId": {
          "type": "string",
          "minLength": 1
        },
        "callId": {
          "$ref": "#/$defs/NativeItemId"
        }
      },
      "required": [
        "instanceId",
        "nativeSessionId",
        "epoch",
        "eventId",
        "sourceId",
        "callId"
      ],
      "additionalProperties": false
    },
    "assignment": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "session"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "attempt"
            },
            "attemptId": {
              "$ref": "#/$defs/AttemptId"
            },
            "relationship": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "root"
                    },
                    "nativeRootTurnId": {
                      "$ref": "#/$defs/NativeRootTurnId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeRootTurnId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "item"
                    },
                    "nativeItemId": {
                      "$ref": "#/$defs/NativeItemId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeItemId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "request"
                    },
                    "nativeRequestId": {
                      "$ref": "#/$defs/NativeRequestId"
                    }
                  },
                  "required": [
                    "kind",
                    "nativeRequestId"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "kind",
            "attemptId",
            "relationship"
          ],
          "additionalProperties": false
        }
      ]
    },
    "phase": {
      "enum": [
        "started",
        "progress",
        "ended"
      ],
      "type": "string"
    },
    "inputSummary": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "outputSummary": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "createdPosition": {
      "$ref": "#/$defs/SyncPosition"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "kind",
    "id",
    "threadId",
    "source",
    "assignment",
    "phase",
    "inputSummary",
    "outputSummary",
    "createdAt",
    "createdPosition",
    "version"
  ],
  "additionalProperties": false
}
```

## ToolActivityReadResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "activityReadStarted"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "kind",
        "subscriptionId",
        "streamId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "activityVersionExpired"
        },
        "replacement": {
          "$ref": "#/$defs/ToolActivityReference"
        }
      },
      "required": [
        "kind",
        "replacement"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "activityUnsupported"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  ]
}
```

## ToolActivityReference

```json
{
  "type": "object",
  "properties": {
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "itemId": {
      "$ref": "#/$defs/TimelineItemId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    },
    "byteLength": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "threadId",
    "itemId",
    "version",
    "byteLength",
    "sha256"
  ],
  "additionalProperties": false
}
```

## TransportFrameHeader

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "lane": {
          "const": "control"
        },
        "epoch": {
          "$ref": "#/$defs/ConnectionId"
        },
        "streamId": {
          "const": 0
        },
        "offsetBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "message": {
          "$ref": "#/$defs/ControlMessage"
        }
      },
      "required": [
        "lane",
        "epoch",
        "streamId",
        "offsetBytes",
        "message"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "lane": {
          "const": "data"
        },
        "epoch": {
          "$ref": "#/$defs/ConnectionId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "offsetBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "message": {
          "$ref": "#/$defs/DataMessage"
        }
      },
      "required": [
        "lane",
        "epoch",
        "streamId",
        "offsetBytes",
        "message"
      ],
      "additionalProperties": false
    },
    {
      "$ref": "#/$defs/FlowWindow"
    }
  ]
}
```

## TransportLimits

```json
{
  "type": "object",
  "properties": {
    "maxControlFrameBytes": {
      "const": 1024
    },
    "maxDataChunkBytes": {
      "const": 1024,
      "description": "Maximum complete binary WebSocket message size, including the length prefix, JSON frame header and raw chunk."
    },
    "initialFlowWindowBytes": {
      "const": 4096
    },
    "maxActiveDataStreams": {
      "const": 32
    },
    "maxPendingDataBytes": {
      "const": 57344
    },
    "maxPendingControlBytes": {
      "const": 8192
    },
    "maxPendingConnectionBytes": {
      "const": 65536
    }
  },
  "required": [
    "maxControlFrameBytes",
    "maxDataChunkBytes",
    "initialFlowWindowBytes",
    "maxActiveDataStreams",
    "maxPendingDataBytes",
    "maxPendingControlBytes",
    "maxPendingConnectionBytes"
  ],
  "additionalProperties": false,
  "description": "The transport counts cumulative byte limits per stream and checks encoded frame length. A stream pauses at its limit. Its subscription ends only on its own backlog or acknowledgement timeout."
}
```

## UnusedInvite

```json
{
  "type": "object",
  "properties": {
    "inviteId": {
      "$ref": "#/$defs/PairingInviteId"
    },
    "target": {
      "$ref": "#/$defs/AuthorizationTarget"
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "enum": [
        "open",
        "selected"
      ],
      "type": "string"
    }
  },
  "required": [
    "inviteId",
    "target",
    "expiresAt",
    "kind"
  ],
  "additionalProperties": false
}
```

## UpgradeRequest

```json
{
  "type": "object",
  "properties": {
    "targetVersion": {
      "$ref": "#/$defs/ReleaseVersion"
    }
  },
  "required": [
    "targetVersion"
  ],
  "additionalProperties": false
}
```

## UpgradeView

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "phase": {
          "const": "idle"
        },
        "activeVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        }
      },
      "required": [
        "phase",
        "activeVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "phase": {
          "enum": [
            "staged",
            "verified",
            "migrating",
            "committed"
          ],
          "type": "string"
        },
        "activeVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        },
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "previousVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        },
        "targetVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        }
      },
      "required": [
        "phase",
        "activeVersion",
        "commandId",
        "previousVersion",
        "targetVersion"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "phase": {
          "enum": [
            "rollingBack",
            "rolledBack"
          ],
          "type": "string"
        },
        "activeVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        },
        "commandId": {
          "$ref": "#/$defs/CommandId"
        },
        "previousVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        },
        "targetVersion": {
          "$ref": "#/$defs/ReleaseVersion"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "phase",
        "activeVersion",
        "commandId",
        "previousVersion",
        "targetVersion",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorkNodeId

```json
{
  "type": "string",
  "minLength": 1
}
```

## WorkRelationship

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "child"
        },
        "parentThreadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "targetThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "parentThreadId",
        "targetThreadId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "fork"
        },
        "parentThreadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "sourceRoundId": {
          "$ref": "#/$defs/RoundId"
        },
        "sideChat": {
          "type": "boolean"
        },
        "targetThreadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "kind",
        "parentThreadId",
        "sourceRoundId",
        "sideChat",
        "targetThreadId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "providerHandoff"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "sourceSessionId": {
          "$ref": "#/$defs/NativeSessionId"
        },
        "targetSessionId": {
          "anyOf": [
            {
              "$ref": "#/$defs/NativeSessionId"
            },
            {
              "type": "null"
            }
          ]
        },
        "messageIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MessageId"
          }
        },
        "history": {
          "$ref": "#/$defs/HistoryCoverage"
        }
      },
      "required": [
        "kind",
        "threadId",
        "sourceSessionId",
        "targetSessionId",
        "messageIds"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorkspaceDirectory

```json
{
  "type": "object",
  "properties": {
    "entries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "enum": [
              "file",
              "directory"
            ],
            "type": "string"
          }
        },
        "required": [
          "name",
          "kind"
        ],
        "additionalProperties": false
      }
    },
    "next": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "entries",
    "next"
  ],
  "additionalProperties": false
}
```

## WorkspaceFileRead

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "complete"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "text": {
          "type": "string"
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1048576
        },
        "digest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "kind",
        "target",
        "path",
        "text",
        "bytes",
        "digest"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "truncated"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "prefix": {
          "type": "string"
        },
        "readBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1048576
        },
        "totalBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "target",
        "path",
        "prefix",
        "readBytes",
        "totalBytes"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorkspaceSearchResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "coverage": {
          "const": "complete"
        },
        "hits": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "content"
                  },
                  "path": {
                    "type": "string",
                    "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                  },
                  "line": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "column": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "preview": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "line",
                  "column",
                  "preview"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "name"
                  },
                  "path": {
                    "type": "string",
                    "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                  },
                  "entryKind": {
                    "enum": [
                      "file",
                      "directory"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "entryKind"
                ],
                "additionalProperties": false
              }
            ]
          }
        }
      },
      "required": [
        "coverage",
        "hits"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "coverage": {
          "const": "partial"
        },
        "hits": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "content"
                  },
                  "path": {
                    "type": "string",
                    "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                  },
                  "line": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "column": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "preview": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "line",
                  "column",
                  "preview"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "name"
                  },
                  "path": {
                    "type": "string",
                    "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
                  },
                  "entryKind": {
                    "enum": [
                      "file",
                      "directory"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "entryKind"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "next": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "coverage",
        "hits",
        "next",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorkspaceTarget

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "project"
        },
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        }
      },
      "required": [
        "kind",
        "projectId",
        "directoryId",
        "generation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "thread"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "directoryId": {
          "type": "string",
          "minLength": 1
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        }
      },
      "required": [
        "kind",
        "threadId",
        "directoryId",
        "generation"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorkspaceWriteResult

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "verified"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "digest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "kind",
        "target",
        "path",
        "digest",
        "bytes"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "conflict",
            "unknown"
          ],
          "type": "string"
        },
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "kind",
        "target",
        "path",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## Worktree

```json
{
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/$defs/WorktreeId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "version": {
      "$ref": "#/$defs/ObjectVersion"
    }
  },
  "required": [
    "id",
    "projectId",
    "version"
  ],
  "additionalProperties": false
}
```

## WorktreeAddress

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "worktreeId": {
      "$ref": "#/$defs/WorktreeId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    }
  },
  "required": [
    "environmentId",
    "projectId",
    "worktreeId",
    "threadId"
  ],
  "additionalProperties": false
}
```

## WorktreeBranchNaming

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "generated"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "fixedPrefix"
        },
        "prefix": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?![-./])(?!.*(?:\\/\\.|\\/\\/|\\.\\.|@\\{|\\.lock\\/))(?!.*[-\\/]$)[^\\x00-\\x20\\x7f~^:?*\\[\\\\]+$"
        }
      },
      "required": [
        "kind",
        "prefix"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorktreeGeneration

```json
{
  "type": "string",
  "pattern": "^(0|[1-9][0-9]*)$"
}
```

## WorktreeId

```json
{
  "type": "string",
  "minLength": 1
}
```

## WorktreeLocation

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "default"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "custom"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![\\s\\S]*\\x00)(?:\\/|[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/]+[\\\\/][^\\\\/]+)"
        }
      },
      "required": [
        "kind",
        "path"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorktreeOrigin

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "selected",
            "localBranch",
            "remoteTracking",
            "projectHead"
          ],
          "type": "string"
        },
        "ref": {
          "type": "string",
          "minLength": 1
        },
        "commit": {
          "$ref": "#/$defs/GitObjectId"
        },
        "prior": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "first"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "rebuild"
                },
                "previousHead": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "oldFiles": {
                  "const": "notRestored"
                }
              },
              "required": [
                "kind",
                "previousHead",
                "oldFiles"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "ref",
        "commit",
        "prior"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "empty"
        },
        "prior": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "first"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "rebuild"
                },
                "previousHead": {
                  "anyOf": [
                    {
                      "$ref": "#/$defs/GitObjectId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "oldFiles": {
                  "const": "notRestored"
                }
              },
              "required": [
                "kind",
                "previousHead",
                "oldFiles"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "prior"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorktreePhase

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "absent"
        },
        "previousHead": {
          "anyOf": [
            {
              "$ref": "#/$defs/GitObjectId"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "previousHead"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "building"
        },
        "origin": {
          "$ref": "#/$defs/WorktreeOrigin"
        }
      },
      "required": [
        "kind",
        "origin"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "preparing"
        },
        "origin": {
          "$ref": "#/$defs/WorktreeOrigin"
        },
        "script": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "queued"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "started"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "unknown"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                }
              },
              "required": [
                "kind",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "failed"
                },
                "attemptId": {
                  "$ref": "#/$defs/AttemptId"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "attemptId",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "kind",
        "origin",
        "script"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "ready"
        },
        "origin": {
          "$ref": "#/$defs/WorktreeOrigin"
        },
        "setup": {
          "enum": [
            "passed",
            "skipped"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "origin",
        "setup"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "removing"
        },
        "saved": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "ready"
            },
            "origin": {
              "$ref": "#/$defs/WorktreeOrigin"
            },
            "setup": {
              "enum": [
                "passed",
                "skipped"
              ],
              "type": "string"
            }
          },
          "required": [
            "kind",
            "origin",
            "setup"
          ],
          "additionalProperties": false
        },
        "checkedHead": {
          "anyOf": [
            {
              "$ref": "#/$defs/GitObjectId"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "kind",
        "saved",
        "checkedHead"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorktreeRetained

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "occupied"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "files"
        },
        "paths": {
          "type": "array",
          "prefixItems": [
            {
              "type": "string",
              "minLength": 1
            }
          ],
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": [
        "kind",
        "paths"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "unpublished"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "const": "uncertain"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  ]
}
```

## WorktreeStatus

```json
{
  "type": "object",
  "properties": {
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "projectId": {
      "$ref": "#/$defs/ProjectId"
    },
    "worktreeId": {
      "$ref": "#/$defs/WorktreeId"
    },
    "threadId": {
      "$ref": "#/$defs/ThreadId"
    },
    "branch": {
      "type": "string",
      "minLength": 1
    },
    "generation": {
      "$ref": "#/$defs/WorktreeGeneration"
    },
    "operationId": {
      "$ref": "#/$defs/CommandId"
    },
    "phase": {
      "$ref": "#/$defs/WorktreePhase"
    }
  },
  "required": [
    "environmentId",
    "projectId",
    "worktreeId",
    "threadId",
    "branch",
    "generation",
    "operationId",
    "phase"
  ],
  "additionalProperties": false
}
```

## WorktreeSubmodules

```json
{
  "enum": [
    "none",
    "topLevel",
    "recursive"
  ],
  "type": "string"
}
```

## WorktreeView

```json
{
  "type": "object",
  "properties": {
    "status": {
      "$ref": "#/$defs/WorktreeStatus"
    },
    "availability": {
      "enum": [
        "usable",
        "unavailable",
        "needsInspection"
      ],
      "type": "string"
    }
  },
  "required": [
    "status",
    "availability"
  ],
  "additionalProperties": false
}
```

## access.grant

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "access.grant"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "principalId": {
          "$ref": "#/$defs/PrincipalId"
        },
        "permission": {
          "$ref": "#/$defs/PermissionItem"
        },
        "inheritance": {
          "enum": [
            "targetOnly",
            "children"
          ],
          "type": "string"
        },
        "modeCeiling": {
          "$ref": "#/$defs/PermissionMode"
        }
      },
      "required": [
        "target",
        "principalId",
        "permission",
        "inheritance",
        "modeCeiling"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## access.listChanges

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "access.listChanges"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## access.listGrants

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "access.listGrants"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## access.listSessions

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "access.listSessions"
    },
    "payload": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## access.revoke

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "access.revoke"
    },
    "payload": {
      "type": "object",
      "properties": {
        "grantId": {
          "$ref": "#/$defs/AccessGrantId"
        }
      },
      "required": [
        "grantId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## app.callback

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "app.callback"
    },
    "payload": {
      "$ref": "#/$defs/AppCallback"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## app.confirm

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "app.confirm"
    },
    "payload": {
      "type": "object",
      "properties": {
        "callback": {
          "$ref": "#/$defs/AppCallback"
        },
        "callbackCommandId": {
          "$ref": "#/$defs/CommandId"
        }
      },
      "required": [
        "callback",
        "callbackCommandId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires owner.decide on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## app.updateNote

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "app.updateNote"
    },
    "payload": {
      "type": "object",
      "properties": {
        "key": {
          "type": "object",
          "properties": {
            "targetThreadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "source": {
              "type": "object",
              "properties": {
                "environmentId": {
                  "$ref": "#/$defs/EnvironmentId"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                },
                "itemId": {
                  "$ref": "#/$defs/TimelineItemId"
                }
              },
              "required": [
                "environmentId",
                "threadId",
                "itemId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "targetThreadId",
            "source"
          ],
          "additionalProperties": false
        },
        "baseVersion": {
          "anyOf": [
            {
              "$ref": "#/$defs/ObjectVersion"
            },
            {
              "type": "null"
            }
          ]
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "key",
        "baseVersion",
        "text"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## attachment.download

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "attachment.download"
    },
    "payload": {
      "type": "object",
      "properties": {
        "transferId": {
          "$ref": "#/$defs/ContentTransferId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "attachment": {
          "$ref": "#/$defs/AttachmentReference"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "transferId",
        "threadId",
        "attachment",
        "streamId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on attachment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## attachment.upload

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "attachment.upload"
    },
    "payload": {
      "type": "object",
      "properties": {
        "transferId": {
          "$ref": "#/$defs/ContentTransferId"
        },
        "attachmentId": {
          "$ref": "#/$defs/AttachmentId"
        },
        "target": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "project"
                },
                "projectId": {
                  "$ref": "#/$defs/ProjectId"
                }
              },
              "required": [
                "kind",
                "projectId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "thread"
                },
                "threadId": {
                  "$ref": "#/$defs/ThreadId"
                }
              },
              "required": [
                "kind",
                "threadId"
              ],
              "additionalProperties": false
            }
          ]
        },
        "byteLength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "mediaType": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [
        "transferId",
        "attachmentId",
        "target",
        "byteLength",
        "mediaType"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## attention.read

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "attention.read"
    },
    "payload": {
      "$ref": "#/$defs/AttentionRead"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.diff

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.diff"
    },
    "payload": {
      "type": "object",
      "properties": {
        "query": {
          "$ref": "#/$defs/DiffRequest"
        },
        "cursor": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "query",
        "cursor"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.readRollbackPart

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.readRollbackPart"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "operationId": {
          "$ref": "#/$defs/CommandId"
        },
        "part": {
          "enum": [
            "dialogue",
            "files"
          ],
          "type": "string"
        }
      },
      "required": [
        "threadId",
        "operationId",
        "part"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.restoreFiles

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.restoreFiles"
    },
    "payload": {
      "$ref": "#/$defs/RollbackTarget"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.retryDialogue

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.retryDialogue"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "operationId": {
          "$ref": "#/$defs/CommandId"
        },
        "expectedExecution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "threadId",
        "operationId",
        "expectedExecution"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.retryFiles

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.retryFiles"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "operationId": {
          "$ref": "#/$defs/CommandId"
        },
        "expectedExecution": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "threadId",
        "operationId",
        "expectedExecution"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.rollback

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.rollback"
    },
    "payload": {
      "$ref": "#/$defs/RollbackTarget"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send and workspace.change on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## checkpoint.rollbackDialogue

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "checkpoint.rollbackDialogue"
    },
    "payload": {
      "$ref": "#/$defs/DialogueRollbackTarget"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.pairing.approve

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.pairing.approve"
    },
    "payload": {
      "type": "object",
      "properties": {
        "requestId": {
          "$ref": "#/$defs/PairingRequestId"
        },
        "confirmationCode": {
          "type": "string",
          "pattern": "^\\d{6}$"
        },
        "permissions": {
          "$ref": "#/$defs/PermissionSet"
        }
      },
      "required": [
        "requestId",
        "confirmationCode",
        "permissions"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.pairing.cancel

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.pairing.cancel"
    },
    "payload": {
      "type": "object",
      "properties": {
        "inviteId": {
          "$ref": "#/$defs/PairingInviteId"
        }
      },
      "required": [
        "inviteId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.pairing.invite

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.pairing.invite"
    },
    "payload": {
      "type": "object",
      "properties": {
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        }
      },
      "required": [
        "projectId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.pairing.listApplications

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.pairing.listApplications"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "inviteId": {
          "$ref": "#/$defs/PairingInviteId"
        }
      },
      "required": [
        "target",
        "after",
        "inviteId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.pairing.listInvites

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.pairing.listInvites"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/AuthorizationTarget"
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## device.revoke

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "device.revoke"
    },
    "payload": {
      "type": "object",
      "properties": {
        "deviceId": {
          "$ref": "#/$defs/DeviceId"
        },
        "deviceKeyId": {
          "$ref": "#/$defs/DeviceKeyId"
        }
      },
      "required": [
        "deviceId",
        "deviceKeyId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires access.give on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## environment.upgrade

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "environment.upgrade"
    },
    "payload": {
      "$ref": "#/$defs/UpgradeRequest"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires environment.upgrade on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## executor.configure

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "executor.configure"
    },
    "payload": {
      "type": "object",
      "properties": {
        "expectedVersion": {
          "anyOf": [
            {
              "$ref": "#/$defs/ObjectVersion"
            },
            {
              "type": "null"
            }
          ]
        },
        "registration": {
          "type": "object",
          "properties": {
            "family": {
              "$ref": "#/$defs/AdapterFamily"
            },
            "instanceId": {
              "$ref": "#/$defs/ExecutorInstanceId"
            },
            "displayName": {
              "type": "string",
              "minLength": 1
            },
            "enabled": {
              "type": "boolean"
            },
            "driver": {
              "type": "object",
              "properties": {
                "executable": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endpoint": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "configurationRoot": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "historyRoot": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "variables": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
                  },
                  "additionalProperties": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "literal"
                          },
                          "value": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "secret"
                          },
                          "binding": {
                            "type": "object",
                            "properties": {
                              "ownerId": {
                                "$ref": "#/$defs/PrincipalId"
                              },
                              "namespace": {
                                "type": "string",
                                "minLength": 1
                              },
                              "key": {
                                "type": "string",
                                "minLength": 1
                              },
                              "version": {
                                "$ref": "#/$defs/ObjectVersion"
                              }
                            },
                            "required": [
                              "ownerId",
                              "namespace",
                              "key",
                              "version"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "required": [
                          "kind",
                          "binding"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                }
              },
              "required": [
                "executable",
                "endpoint",
                "configurationRoot",
                "historyRoot",
                "variables"
              ],
              "additionalProperties": false
            },
            "credential": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "ownerId": {
                      "$ref": "#/$defs/PrincipalId"
                    },
                    "namespace": {
                      "type": "string",
                      "minLength": 1
                    },
                    "key": {
                      "type": "string",
                      "minLength": 1
                    },
                    "version": {
                      "$ref": "#/$defs/ObjectVersion"
                    }
                  },
                  "required": [
                    "ownerId",
                    "namespace",
                    "key",
                    "version"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "model": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "options": {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "number"
                          },
                          {
                            "type": "boolean"
                          }
                        ]
                      }
                    }
                  },
                  "required": [
                    "id",
                    "options"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "permission": {
              "$ref": "#/$defs/InstancePermission"
            }
          },
          "required": [
            "family",
            "instanceId",
            "displayName",
            "enabled",
            "driver",
            "credential",
            "model",
            "permission"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "expectedVersion",
        "registration"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires settings.change on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## executor.refresh

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "executor.refresh"
    },
    "payload": {
      "type": "object",
      "properties": {
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "instanceId": {
          "$ref": "#/$defs/ExecutorInstanceId"
        }
      },
      "required": [
        "projectId",
        "instanceId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## forge.fileReading

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "forge.fileReading"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "file": {
          "$ref": "#/$defs/ForgeFileKey"
        }
      },
      "required": [
        "threadId",
        "file"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## forge.history

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "forge.history"
    },
    "payload": {
      "type": "object",
      "properties": {
        "watch": {
          "$ref": "#/$defs/ForgeWatch"
        },
        "from": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "through": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "watch",
        "from",
        "through"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## forge.markFile

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "forge.markFile"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "file": {
          "$ref": "#/$defs/ForgeFileKey"
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "mark": {
          "$ref": "#/$defs/ForgeReadMark"
        }
      },
      "required": [
        "threadId",
        "file",
        "baseVersion",
        "mark"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## forge.operation

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "forge.operation"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "operationId": {
          "$ref": "#/$defs/CommandId"
        }
      },
      "required": [
        "threadId",
        "operationId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## forge.publish

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "forge.publish"
    },
    "payload": {
      "$ref": "#/$defs/ForgePublish"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## git.readStatus

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "git.readStatus"
    },
    "payload": {
      "$ref": "#/$defs/GitStatusRequest"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## git.subscribeStatus

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "git.subscribeStatus"
    },
    "payload": {
      "$ref": "#/$defs/GitSubscribe"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## history.pageSaved

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "history.pageSaved"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "anchor": {
          "$ref": "#/$defs/HistoryAnchorId"
        },
        "pageNumber": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "threadId",
        "anchor",
        "pageNumber"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## host.listDirectory

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "host.listDirectory"
    },
    "payload": {
      "type": "object",
      "properties": {
        "directory": {
          "type": "string"
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "directory",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.cancelQueued

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.cancelQueued"
    },
    "payload": {
      "$ref": "#/$defs/QueuedTarget"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.dropUnknown

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.dropUnknown"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        }
      },
      "required": [
        "threadId",
        "attemptId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.editQueued

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.editQueued"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "roundId": {
          "$ref": "#/$defs/RoundId"
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "content": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "references": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/MessageReference"
              }
            },
            "attachments": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AttachmentReference"
              }
            }
          },
          "required": [
            "text",
            "references",
            "attachments"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "threadId",
        "roundId",
        "baseVersion",
        "content"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.releaseQueue

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.releaseQueue"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "threadId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.reorderQueue

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.reorderQueue"
    },
    "payload": {
      "$ref": "#/$defs/QueueOrder"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.resendUnknown

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.resendUnknown"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        }
      },
      "required": [
        "threadId",
        "attemptId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.send

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.send"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "content": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "references": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/MessageReference"
              }
            },
            "attachments": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AttachmentReference"
              }
            }
          },
          "required": [
            "text",
            "references",
            "attachments"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "threadId",
        "content"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## input.steer

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "input.steer"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        },
        "mode": {
          "enum": [
            "queueNext",
            "insertCurrent",
            "restartCurrent"
          ],
          "type": "string"
        },
        "content": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "references": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/MessageReference"
              }
            },
            "attachments": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AttachmentReference"
              }
            }
          },
          "required": [
            "text",
            "references",
            "attachments"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "threadId",
        "attemptId",
        "mode",
        "content"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## project.register

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "project.register"
    },
    "payload": {
      "type": "object",
      "properties": {
        "realPath": {
          "type": "string",
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)"
        }
      },
      "required": [
        "realPath"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## round.readStop

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "round.readStop"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "stopCommandId": {
          "$ref": "#/$defs/CommandId"
        }
      },
      "required": [
        "threadId",
        "stopCommandId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## round.stop

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "round.stop"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "attemptId": {
          "$ref": "#/$defs/AttemptId"
        }
      },
      "required": [
        "threadId",
        "attemptId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## settings.read

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "settings.read"
    },
    "payload": {
      "$ref": "#/$defs/SettingRead"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## settings.write

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "settings.write"
    },
    "payload": {
      "$ref": "#/$defs/SettingWrite"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires settings.change on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.close

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.close"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        }
      },
      "required": [
        "subscriptionId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on subscription. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.gap

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.gap"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "after": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncCursor"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "subscriptionId",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on subscription. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.installed

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.installed"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "passId": {
          "$ref": "#/$defs/SyncPassId"
        },
        "cursor": {
          "$ref": "#/$defs/SyncCursor"
        }
      },
      "required": [
        "subscriptionId",
        "passId",
        "cursor"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on subscription. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.openList

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.openList"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "after": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncCursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "recheckTodos": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TodoRequestId"
          }
        },
        "projectId": {
          "anyOf": [
            {
              "$ref": "#/$defs/ProjectId"
            },
            {
              "type": "null"
            }
          ]
        },
        "windowShapeVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        },
        "knownThreads": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "threadId": {
                "$ref": "#/$defs/ThreadId"
              },
              "version": {
                "$ref": "#/$defs/ObjectVersion"
              }
            },
            "required": [
              "threadId",
              "version"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "subscriptionId",
        "streamId",
        "after",
        "recheckTodos",
        "projectId",
        "windowShapeVersion",
        "knownThreads"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on environment. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.openThread

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.openThread"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "knownWindow": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "$ref": "#/$defs/ObjectKey"
              },
              "version": {
                "$ref": "#/$defs/ObjectVersion"
              }
            },
            "required": [
              "key",
              "version"
            ],
            "additionalProperties": false
          }
        },
        "after": {
          "anyOf": [
            {
              "$ref": "#/$defs/SyncCursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "recheckTodos": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TodoRequestId"
          }
        }
      },
      "required": [
        "subscriptionId",
        "streamId",
        "threadId",
        "knownWindow",
        "after",
        "recheckTodos"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## subscription.pageSaved

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "subscription.pageSaved"
    },
    "payload": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "passId": {
          "$ref": "#/$defs/SyncPassId"
        },
        "pageNumber": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "subscriptionId",
        "passId",
        "pageNumber"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on subscription. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.ack

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.ack"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "through": {
          "$ref": "#/$defs/TerminalOffset"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId",
        "through"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.attach

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.attach"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "after": {
          "$ref": "#/$defs/TerminalOffset"
        },
        "grid": {
          "$ref": "#/$defs/TerminalGrid"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId",
        "after",
        "grid",
        "streamId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.close

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.close"
    },
    "payload": {
      "$ref": "#/$defs/TerminalAddress"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.input on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.control

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.control"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.input on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.detach

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.detach"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.open

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.open"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "grid": {
          "$ref": "#/$defs/TerminalGrid"
        }
      },
      "required": [
        "threadId",
        "grid"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.input on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.resize

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.resize"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "grid": {
          "$ref": "#/$defs/TerminalGrid"
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId",
        "grid"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## terminal.write

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "terminal.write"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "terminalId": {
          "$ref": "#/$defs/TerminalId"
        },
        "generation": {
          "$ref": "#/$defs/TerminalGeneration"
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "lease": {
          "$ref": "#/$defs/CommandId"
        },
        "bytes": {
          "type": "string",
          "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          "minLength": 4,
          "description": "Raw input bytes encoded as padded base64. The signed command ID identifies this write."
        }
      },
      "required": [
        "threadId",
        "terminalId",
        "generation",
        "subscriptionId",
        "lease",
        "bytes"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires term.input on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.cancelChild

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.cancelChild"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "taskId": {
          "$ref": "#/$defs/ChildTaskId"
        }
      },
      "required": [
        "threadId",
        "taskId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.changeLifecycle

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.changeLifecycle"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "baseVersion": {
          "$ref": "#/$defs/ObjectVersion"
        },
        "change": {
          "$ref": "#/$defs/ThreadChange"
        }
      },
      "required": [
        "threadId",
        "baseVersion",
        "change"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.clear

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.clear"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "threadId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.compact

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.compact"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "instructions": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "threadId",
        "instructions"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.inspectCheckout

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.inspectCheckout"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        }
      },
      "required": [
        "threadId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.launchChildren

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.launchChildren"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "mode": {
          "enum": [
            "topLevel",
            "delegate"
          ],
          "type": "string"
        },
        "items": {
          "type": "array",
          "prefixItems": [
            {
              "$ref": "#/$defs/ChildLaunch"
            }
          ],
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/ChildLaunch"
          }
        }
      },
      "required": [
        "threadId",
        "mode",
        "items"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.readChild

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.readChild"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "taskId": {
          "$ref": "#/$defs/ChildTaskId"
        },
        "waitMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 45000
        }
      },
      "required": [
        "threadId",
        "taskId",
        "waitMs"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.readEarlierSettled

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.readEarlierSettled"
    },
    "payload": {
      "$ref": "#/$defs/EarlierSettledRequest"
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on authorizationTarget. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.readHistory

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.readHistory"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "anchor": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryAnchorId"
            },
            {
              "type": "null"
            }
          ]
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "threadId",
        "anchor",
        "streamId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.rename

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.rename"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "title": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "threadId",
        "title"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## thread.start

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "thread.start"
    },
    "payload": {
      "type": "object",
      "properties": {
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "worktreeId": {
          "anyOf": [
            {
              "$ref": "#/$defs/WorktreeId"
            },
            {
              "type": "null"
            }
          ]
        },
        "instanceId": {
          "$ref": "#/$defs/ExecutorInstanceId"
        },
        "model": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "options": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            }
          },
          "required": [
            "id",
            "options"
          ],
          "additionalProperties": false
        },
        "content": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "references": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/MessageReference"
              }
            },
            "attachments": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AttachmentReference"
              }
            }
          },
          "required": [
            "text",
            "references",
            "attachments"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "projectId",
        "worktreeId",
        "content"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.send on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## todo.answer

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "todo.answer"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        },
        "answers": {
          "type": "array",
          "prefixItems": [
            {
              "type": "object",
              "properties": {
                "questionKey": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "answer": {
                  "type": "string",
                  "maxLength": 8192
                }
              },
              "required": [
                "questionKey",
                "answer"
              ],
              "additionalProperties": false
            }
          ],
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "questionKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "answer": {
                "type": "string",
                "maxLength": 8192
              }
            },
            "required": [
              "questionKey",
              "answer"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "threadId",
        "todoRequestId",
        "answers"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.reply on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## todo.decide

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "todo.decide"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        },
        "decision": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "approval"
                },
                "choiceKey": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "decision": {
                  "enum": [
                    "allow",
                    "deny",
                    "allowEdited"
                  ],
                  "type": "string"
                },
                "scope": {
                  "enum": [
                    "once",
                    "session",
                    "project",
                    "persistent"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "choiceKey",
                "decision",
                "scope"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "secret"
                },
                "receiptCommandId": {
                  "$ref": "#/$defs/CommandId"
                }
              },
              "required": [
                "kind",
                "receiptCommandId"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "threadId",
        "todoRequestId",
        "decision"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires owner.decide on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## todo.readAnswer

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "todo.readAnswer"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        }
      },
      "required": [
        "threadId",
        "todoRequestId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## todo.readSecretReceipt

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "todo.readSecretReceipt"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "todoRequestId": {
          "$ref": "#/$defs/TodoRequestId"
        },
        "receiptCommandId": {
          "$ref": "#/$defs/CommandId"
        }
      },
      "required": [
        "threadId",
        "todoRequestId",
        "receiptCommandId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires owner.decide on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## tool.readActivity

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "tool.readActivity"
    },
    "payload": {
      "type": "object",
      "properties": {
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "itemId": {
          "$ref": "#/$defs/TimelineItemId"
        },
        "expectedVersion": {
          "anyOf": [
            {
              "$ref": "#/$defs/ObjectVersion"
            },
            {
              "type": "null"
            }
          ]
        },
        "subscriptionId": {
          "$ref": "#/$defs/SubscriptionId"
        },
        "streamId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "threadId",
        "itemId",
        "expectedVersion",
        "subscriptionId",
        "streamId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on thread. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## workspace.list

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "workspace.list"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "directory": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
            },
            {
              "type": "null"
            }
          ]
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "directory",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## workspace.openEditor

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "workspace.openEditor"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "line": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "column": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "target",
        "path",
        "line",
        "column"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change and thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## workspace.readFile

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "workspace.readFile"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        }
      },
      "required": [
        "target",
        "path"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## workspace.search

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "workspace.search"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "mode": {
          "enum": [
            "name",
            "content"
          ],
          "type": "string"
        },
        "query": {
          "type": "string",
          "minLength": 1
        },
        "after": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "mode",
        "query",
        "after"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## workspace.writeFile

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "workspace.writeFile"
    },
    "payload": {
      "type": "object",
      "properties": {
        "target": {
          "$ref": "#/$defs/WorkspaceTarget"
        },
        "path": {
          "type": "string",
          "pattern": "^(?![A-Za-z]:)(?![/\\\\])(?![\\s\\S]*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\x00]+$"
        },
        "text": {
          "type": "string"
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "digest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "expected": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "absent"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "complete"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "kind",
                "digest"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "target",
        "path",
        "text",
        "bytes",
        "digest",
        "expected"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change and thread.view on workspace. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## worktree.clean

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "worktree.clean"
    },
    "payload": {
      "type": "object",
      "properties": {
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        }
      },
      "required": [
        "projectId",
        "threadId",
        "worktreeId",
        "generation"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## worktree.prepare

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "worktree.prepare"
    },
    "payload": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "projectId": {
              "$ref": "#/$defs/ProjectId"
            },
            "threadId": {
              "$ref": "#/$defs/ThreadId"
            },
            "worktreeId": {
              "$ref": "#/$defs/WorktreeId"
            },
            "branch": {
              "type": "string",
              "minLength": 1
            },
            "baseRef": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "projectId",
            "threadId",
            "worktreeId",
            "branch",
            "baseRef"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "projectId": {
              "$ref": "#/$defs/ProjectId"
            },
            "worktreeId": {
              "$ref": "#/$defs/WorktreeId"
            },
            "branch": {
              "type": "string",
              "minLength": 1
            },
            "baseRef": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "projectId",
            "worktreeId",
            "branch",
            "baseRef"
          ],
          "additionalProperties": false
        }
      ]
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```

## worktree.retrySetup

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "const": "signedRequest"
    },
    "protocolVersion": {
      "$ref": "#/$defs/ProtocolVersion"
    },
    "environmentId": {
      "$ref": "#/$defs/EnvironmentId"
    },
    "connectionId": {
      "$ref": "#/$defs/ConnectionId"
    },
    "challengeId": {
      "$ref": "#/$defs/ConnectionChallengeId"
    },
    "challenge": {
      "$ref": "#/$defs/ConnectionChallenge"
    },
    "signer": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "device"
            },
            "deviceId": {
              "$ref": "#/$defs/DeviceId"
            },
            "keyId": {
              "$ref": "#/$defs/DeviceKeyId"
            }
          },
          "required": [
            "kind",
            "deviceId",
            "keyId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "executor"
            },
            "principalId": {
              "$ref": "#/$defs/PrincipalId"
            },
            "keyId": {
              "$ref": "#/$defs/ExecutorKeyId"
            }
          },
          "required": [
            "kind",
            "principalId",
            "keyId"
          ],
          "additionalProperties": false
        }
      ]
    },
    "sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "commandId": {
      "$ref": "#/$defs/CommandId"
    },
    "method": {
      "const": "worktree.retrySetup"
    },
    "payload": {
      "type": "object",
      "properties": {
        "projectId": {
          "$ref": "#/$defs/ProjectId"
        },
        "threadId": {
          "$ref": "#/$defs/ThreadId"
        },
        "worktreeId": {
          "$ref": "#/$defs/WorktreeId"
        },
        "generation": {
          "$ref": "#/$defs/WorktreeGeneration"
        },
        "previousAttemptId": {
          "$ref": "#/$defs/AttemptId"
        }
      },
      "required": [
        "projectId",
        "threadId",
        "worktreeId",
        "generation",
        "previousAttemptId"
      ],
      "additionalProperties": false
    },
    "signature": {
      "$ref": "#/$defs/P256Signature"
    }
  },
  "required": [
    "kind",
    "protocolVersion",
    "environmentId",
    "connectionId",
    "challengeId",
    "challenge",
    "signer",
    "sequence",
    "commandId",
    "method",
    "payload",
    "signature"
  ],
  "additionalProperties": false,
  "description": "Requires workspace.change on project. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID."
}
```
