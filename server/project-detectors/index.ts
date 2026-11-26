import { commonDetector } from "./common";
import { goDetector } from "./go";
import { inventoryDetector } from "./inventory";
import { javascriptDetector } from "./javascript";
import { phpDetector } from "./php";

export const projectDetectors = [commonDetector, javascriptDetector, goDetector, phpDetector, inventoryDetector];
