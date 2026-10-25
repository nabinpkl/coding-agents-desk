// Every setting Group reads, in one place. The supervisor that starts Group sets these; a missing
// port fails at start with the variable's name rather than picking one nobody routes to.
import * as Config from "effect/Config";

export const serverOptions = {
  port: Config.Port("AGENTDESK_GROUP_PORT"),
  hostname: Config.String("AGENTDESK_GROUP_HOST").pipe(Config.withDefault("127.0.0.1")),
};
