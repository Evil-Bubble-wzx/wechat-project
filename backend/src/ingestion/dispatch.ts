export function ingestionQueueId(id:string,generation=0):string {
  return generation===0?`ingestion-${id}`:`ingestion-${id}-g${generation}`;
}
