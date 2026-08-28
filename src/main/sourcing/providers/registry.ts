// Wires every source plugin together. The only file that needs to change
// when a new source is added.
import type { SourceId, SourcePlugin } from "../../../shared/sourcing";
import { thingiverseProvider } from "./thingiverse";
import { printablesProvider } from "./printables";
import { myminifactoryProvider } from "./myminifactory";
import { nih3dProvider } from "./nih3d";
import { smithsonianProvider } from "./smithsonian";
import { nasaProvider } from "./nasa";
import { githubProvider } from "./github";
import { makerworldProvider } from "./makerworld";
import { thangsProvider } from "./thangs";
import { yeggiProvider } from "./yeggi";
import { stlfinderProvider } from "./stlfinder";

const ALL_PROVIDERS: SourcePlugin[] = [
  thingiverseProvider,
  printablesProvider,
  myminifactoryProvider,
  nih3dProvider,
  smithsonianProvider,
  nasaProvider,
  githubProvider,
  makerworldProvider,
  thangsProvider,
  yeggiProvider,
  stlfinderProvider,
];

export function allProviders(): SourcePlugin[] {
  return ALL_PROVIDERS;
}

export function getProvider(id: SourceId): SourcePlugin | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
