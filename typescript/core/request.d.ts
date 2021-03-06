declare module qtek {

    export module core {

        export module request {

            interface IRequestOption {
                url: string;
                responseType?: string;
                onprogress?: (percent: number, loaded: number, total: number) => any;
                onload?: (response: any) => any;
                onerror?: Function;
            }

            export function get(option: IRequestOption): void;
        }
    }
}