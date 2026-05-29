#pragma once

#include "Commandlets/Commandlet.h"
#include "UEMatExportMetadataCommandlet.generated.h"

UCLASS()
class UEMATEXPORTMETADATA_API UUEMatExportMetadataCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UUEMatExportMetadataCommandlet();

    virtual int32 Main(const FString& Params) override;
};
